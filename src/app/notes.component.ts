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
import { ConflictError, NotesService, UnauthorizedError } from './notes.service';

/**
 * Quiet period after the last keystroke before autosaving. Every save is a
 * function call plus a blob write, so this is long enough to batch a burst of
 * typing; leaving the tab flushes immediately regardless.
 */
const SAVE_DELAY_MS = 4_000;
/** Back-off before retrying a save that failed for a transient reason. */
const RETRY_DELAY_MS = 10_000;

/**
 * Where the password is kept once the server has accepted it. Session storage
 * lasts only for the browser tab's lifetime, then the password is asked again.
 * The password itself is checked server-side on every request (see
 * netlify/lib/notes.mts); the browser holds no copy of the expected value.
 */
const KEY_STORAGE = 'notes.key';

type View = 'locked' | 'loading' | 'ready' | 'error';
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

  private key: string | null = readStoredKey();

  readonly view = signal<View>(this.key ? 'loading' : 'locked');
  readonly saveState = signal<SaveState>('saved');
  readonly error = signal<string | null>(null);
  readonly password = signal('');
  readonly unlocking = signal(false);

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
    // Nothing is fetched while locked, so the notes never reach the page early.
    afterNextRender(() => {
      if (this.view() !== 'locked') void this.load();
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.saveTimer);
  }

  // --- lock / unlock -------------------------------------------------------------

  onPasswordInput(event: Event): void {
    this.password.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  async unlock(event: Event): Promise<void> {
    event.preventDefault();
    const attempt = this.password();
    if (!attempt || this.unlocking()) return;

    // The server is the judge: a wrong password comes back as a 401 from load.
    this.key = attempt;
    this.unlocking.set(true);
    const ok = await this.load();
    this.unlocking.set(false);

    if (ok) {
      storeKey(attempt);
      this.password.set('');
    }
  }

  lock(): void {
    if (this.hasUnsaved() && !confirm('Some changes have not been saved yet. Lock anyway and lose them?')) {
      return;
    }
    this.resetToLocked(null);
  }

  /** Forgets the password and clears the editor, optionally explaining why. */
  private resetToLocked(message: string | null): void {
    clearTimeout(this.saveTimer);
    forgetStoredKey();
    this.key = null;
    this.setEditorHtml('');
    this.etag = null;
    this.saveState.set('saved');
    this.error.set(message);
    this.view.set('locked');
  }

  // --- load / save -------------------------------------------------------------

  /**
   * Replaces the editor with the stored notes. A background refresh keeps the
   * editor usable and backs off if the user starts typing mid-request.
   */
  async load(background = false): Promise<boolean> {
    if (!this.key) return false;
    clearTimeout(this.saveTimer);
    if (!background) {
      // While unlocking, the password form stays up until the server answers.
      if (this.view() !== 'locked') this.view.set('loading');
      this.error.set(null);
    }

    const startRevision = this.revision;
    try {
      const snapshot = await this.api.load(this.key);
      if (background && this.revision !== startRevision) return false;

      this.setEditorHtml(snapshot.html);
      this.etag = snapshot.etag;
      this.saveState.set('saved');
      this.error.set(null);
      this.view.set('ready');
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        this.resetToLocked(err.message);
      } else if (!background) {
        // A failed background refresh leaves the current notes in place.
        this.error.set(messageOf(err));
        if (this.view() !== 'locked') this.view.set('error');
      }
      return false;
    }
  }

  async save(force = false): Promise<void> {
    clearTimeout(this.saveTimer);
    // A save already in flight re-checks the revision when it lands and
    // schedules another if needed, so overlapping requests are never sent.
    if (!this.key || this.saving || this.view() !== 'ready') return;

    const startRevision = this.revision;
    this.saving = true;
    this.saveState.set('saving');

    try {
      this.etag = await this.api.save(this.key, this.editor().nativeElement.innerHTML, this.etag, force);
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
      } else if (err instanceof UnauthorizedError) {
        this.resetToLocked(err.message);
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
    if (!this.key || this.view() !== 'ready' || this.saveState() !== 'saved') return;
    try {
      const latest = await this.api.peekEtag(this.key);
      if (latest !== this.etag && this.saveState() === 'saved') await this.load(true);
    } catch (err) {
      if (err instanceof UnauthorizedError) this.resetToLocked(err.message);
      // Anything else leaves a stale view, which is harmless: the next save
      // is refused as a conflict.
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

// Storage can throw in private windows or with site data blocked; the box
// then simply asks for the password on every visit.
function readStoredKey(): string | null {
  try {
    return sessionStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

function storeKey(key: string): void {
  try {
    sessionStorage.setItem(KEY_STORAGE, key);
  } catch {
    /* not remembered for this tab */
  }
}

function forgetStoredKey(): void {
  try {
    sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    /* nothing stored */
  }
}
