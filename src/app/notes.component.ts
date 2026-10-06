import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  SecurityContext,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { ConflictError, NotesService } from './notes.service';

/** Quiet period after the last keystroke before autosaving. */
const SAVE_DELAY_MS = 1_200;
/** Back-off before retrying a save that failed for a transient reason. */
const RETRY_DELAY_MS = 10_000;

type View = 'loading' | 'ready' | 'error';
type SaveState = 'saved' | 'dirty' | 'saving' | 'failed' | 'conflict';

const STATUS_LABELS: Record<SaveState, string> = {
  saved: 'Saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  failed: 'Not saved',
  conflict: 'Not saved',
};

/**
 * A single rich-text scratchpad, synced across devices through Blob Storage.
 *
 * The editor is a plain contenteditable div that Angular never re-renders, so
 * the caret and undo history survive change detection. Everything that goes
 * into it - loaded notes and pasted HTML alike - passes through Angular's HTML
 * sanitizer first, which strips scripts, event handlers and inline styles.
 */
@Component({
  selector: 'app-notes',
  templateUrl: './notes.component.html',
  styleUrl: './notes.component.css',
})
export class NotesComponent implements OnDestroy {
  private readonly api = inject(NotesService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly editor = viewChild.required<ElementRef<HTMLDivElement>>('editor');

  readonly view = signal<View>('loading');
  readonly saveState = signal<SaveState>('saved');
  readonly error = signal<string | null>(null);

  readonly statusLabel = computed(() => STATUS_LABELS[this.saveState()]);
  readonly hasUnsaved = computed(() => this.saveState() !== 'saved');

  /** Version of the stored notes this editor was loaded from or last saved as. */
  private etag: string | null = null;
  /** Bumped on every edit, so a save can tell whether typing continued under it. */
  private revision = 0;
  private saving = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  /** Last caret position inside the editor, for toolbar actions that steal focus. */
  private savedRange: Range | null = null;

  constructor() {
    // The editor element must exist before notes can be written into it.
    afterNextRender(() => void this.load());
  }

  ngOnDestroy(): void {
    clearTimeout(this.saveTimer);
  }

  // --- load / save -------------------------------------------------------------

  /**
   * Replaces the editor with the stored notes. A background refresh keeps the
   * editor usable and backs off if the user starts typing mid-request.
   */
  async load(background = false): Promise<void> {
    clearTimeout(this.saveTimer);
    if (!background) {
      this.view.set('loading');
      this.error.set(null);
    }

    const startRevision = this.revision;
    try {
      const snapshot = await this.api.load();
      if (background && this.revision !== startRevision) return;

      this.setEditorHtml(snapshot.html);
      this.etag = snapshot.etag;
      this.saveState.set('saved');
      this.error.set(null);
      this.view.set('ready');
    } catch (err) {
      // A failed background refresh leaves the current notes in place.
      if (!background) {
        this.error.set(messageOf(err));
        this.view.set('error');
      }
    }
  }

  async save(force = false): Promise<void> {
    clearTimeout(this.saveTimer);
    // A save already in flight re-checks the revision when it lands and
    // schedules another if needed, so overlapping requests are never sent.
    if (this.saving || this.view() !== 'ready') return;

    const startRevision = this.revision;
    this.saving = true;
    this.saveState.set('saving');

    try {
      this.etag = await this.api.save(this.editor().nativeElement.innerHTML, this.etag, force);
      this.error.set(null);
      if (this.revision !== startRevision) {
        this.saveState.set('dirty');
        this.scheduleSave(SAVE_DELAY_MS);
      } else {
        this.saveState.set('saved');
      }
    } catch (err) {
      if (err instanceof ConflictError) {
        // Stop autosaving until the user decides which copy wins.
        this.saveState.set('conflict');
      } else {
        this.saveState.set('failed');
        this.error.set(messageOf(err));
        this.scheduleSave(RETRY_DELAY_MS);
      }
    } finally {
      this.saving = false;
    }
  }

  /** Conflict resolution: discard local edits and take the stored copy. */
  loadLatest(): void {
    void this.load();
  }

  /** Conflict resolution: overwrite the stored copy with what is on screen. */
  keepMine(): void {
    void this.save(true);
  }

  private scheduleSave(delay: number): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), delay);
  }

  // --- editing -----------------------------------------------------------------

  onInput(): void {
    this.revision++;
    if (this.saveState() === 'conflict') return;
    this.saveState.set('dirty');
    this.scheduleSave(SAVE_DELAY_MS);
  }

  async onPaste(event: ClipboardEvent): Promise<void> {
    const data = event.clipboardData;
    if (!data) return;

    const html = data.getData('text/html');
    const images = imageFiles(data);

    // Office apps put both rich HTML and a rendered picture of the selection
    // on the clipboard; the HTML is what the user means. A bare "copy image"
    // carries HTML with no text, and there the image file is the better copy.
    if (html && (!images.length || hasVisibleText(html))) {
      event.preventDefault();
      this.insertHtml(this.clean(html));
    } else if (images.length) {
      event.preventDefault();
      await this.insertImages(images);
    }
    // Plain text falls through to the browser's own paste.
  }

  onDragOver(event: DragEvent): void {
    // Accept file drags so the browser does not navigate away to the file.
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  }

  async onDrop(event: DragEvent): Promise<void> {
    const transfer = event.dataTransfer;
    if (!transfer?.types.includes('Files')) return; // dragged text: browser default
    event.preventDefault();

    const images = imageFiles(transfer);
    if (!images.length) {
      this.error.set('Only images can be dropped into notes.');
      return;
    }
    this.placeCaretAt(event.clientX, event.clientY);
    await this.insertImages(images);
  }

  async onImagePicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const images = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'));
    // Reset so picking the same file again still fires a change event.
    input.value = '';
    await this.insertImages(images);
  }

  format(command: 'bold' | 'italic' | 'insertUnorderedList'): void {
    this.restoreSelection();
    document.execCommand(command);
  }

  @HostListener('document:selectionchange')
  onSelectionChange(): void {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (this.editor().nativeElement.contains(range.commonAncestorContainer)) {
      this.savedRange = range.cloneRange();
    }
  }

  // --- page lifecycle ----------------------------------------------------------

  @HostListener('document:visibilitychange')
  onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') {
      // Flush now: a backgrounded mobile tab may never run the timer.
      if (this.saveState() === 'dirty') void this.save();
    } else {
      void this.refreshIfStale();
    }
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.view() === 'ready' && this.hasUnsaved()) {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  /**
   * Coming back to a tab that was left open: if nothing is pending here and
   * the notes were edited elsewhere, pull the newer copy in before the user
   * types over a stale one.
   */
  private async refreshIfStale(): Promise<void> {
    if (this.view() !== 'ready' || this.saveState() !== 'saved') return;
    try {
      const latest = await this.api.peekEtag();
      if (latest !== this.etag && this.saveState() === 'saved') await this.load(true);
    } catch {
      // A stale view is harmless: the next save is refused as a conflict.
    }
  }

  // --- DOM helpers ---------------------------------------------------------------

  private async insertImages(files: File[]): Promise<void> {
    for (const file of files) {
      try {
        const src = await this.api.prepareImage(file);
        // `src` is a data URL the browser just produced: no quotes to escape.
        this.insertHtml(`<img src="${src}" alt="">`);
      } catch {
        this.error.set(`Could not read ${file.name || 'that image'}.`);
      }
    }
  }

  /**
   * Inserts at the caret via execCommand, which is deprecated but remains the
   * only way to edit a contenteditable that keeps native undo working. It also
   * fires `input`, which triggers autosave.
   */
  private insertHtml(html: string): void {
    this.restoreSelection();
    document.execCommand('insertHTML', false, html);
  }

  /** Puts the caret back in the editor if a toolbar click or file picker took it. */
  private restoreSelection(): void {
    const el = this.editor().nativeElement;
    const selection = window.getSelection();
    if (!selection) return;
    if (selection.rangeCount && el.contains(selection.getRangeAt(0).commonAncestorContainer)) return;

    el.focus();
    let range = this.savedRange;
    if (!range || !el.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(range);
  }

  private placeCaretAt(x: number, y: number): void {
    const doc = document as unknown as CaretDocument;
    let range: Range | null = null;
    if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(x, y);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    } else if (doc.caretRangeFromPoint) {
      range = doc.caretRangeFromPoint(x, y);
    }
    if (range && this.editor().nativeElement.contains(range.startContainer)) {
      range.collapse(true);
      this.savedRange = range;
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }

  private setEditorHtml(html: string): void {
    this.editor().nativeElement.innerHTML = this.clean(html);
    this.savedRange = null;
  }

  private clean(html: string): string {
    return this.sanitizer.sanitize(SecurityContext.HTML, html) ?? '';
  }
}

/** Both caret-from-point APIs, optional because older browsers ship only one. */
interface CaretDocument {
  caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?(x: number, y: number): Range | null;
}

function imageFiles(transfer: DataTransfer): File[] {
  let files = Array.from(transfer.files);
  // Some browsers expose pasted images only through `items`.
  if (!files.length) {
    files = Array.from(transfer.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => !!f);
  }
  return files.filter((f) => f.type.startsWith('image/'));
}

function hasVisibleText(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return !!doc.body.textContent?.trim();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}
