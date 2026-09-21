import { Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslationService } from './translation.service';
import {
  ACCEPTED_EXTENSIONS,
  MAX_FILE_BYTES,
  formatBytes,
  type JobState,
  type Language,
} from './translation.models';

@Component({
  selector: 'app-root',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {
  private readonly api = inject(TranslationService);

  readonly accept = ACCEPTED_EXTENSIONS.join(',');
  readonly formatBytes = formatBytes;

  readonly languages = signal<Language[]>([]);
  readonly languagesError = signal<string | null>(null);
  readonly file = signal<File | null>(null);
  readonly fileError = signal<string | null>(null);
  readonly dragging = signal(false);
  readonly sourceLanguage = signal('');
  readonly targetLanguage = signal('es');

  readonly job = signal<JobState>({ phase: 'idle', progress: -1, message: '' });

  readonly busy = computed(() => {
    const phase = this.job().phase;
    return phase !== 'idle' && phase !== 'done' && phase !== 'error';
  });

  readonly canTranslate = computed(
    () => !!this.file() && !!this.targetLanguage() && !this.busy() && !this.fileError()
  );

  /** Percentage for the bar, or null when the phase has nothing to measure. */
  readonly progressPercent = computed(() => {
    const { progress } = this.job();
    return progress >= 0 ? progress : null;
  });

  readonly targetLanguageName = computed(
    () => this.languages().find((l) => l.code === this.targetLanguage())?.name ?? this.targetLanguage()
  );

  constructor() {
    void this.loadLanguages();
  }

  private async loadLanguages(): Promise<void> {
    try {
      this.languages.set(await this.api.listLanguages());
      this.languagesError.set(null);
    } catch (err) {
      // The picker falls back to a small built-in list so the app stays usable.
      this.languagesError.set(this.messageOf(err));
      this.languages.set(FALLBACK_LANGUAGES);
    }
  }

  // --- file selection -------------------------------------------------------

  onFileInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.selectFile(input.files?.[0] ?? null);
    // Reset so re-picking the same file still fires a change event.
    input.value = '';
  }

  onDragOver(event: DragEvent): void {
    // Always cancel the default, or the browser navigates away to the file.
    event.preventDefault();
    if (!this.busy()) this.dragging.set(true);
  }

  onDragLeave(): void {
    this.dragging.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    // The file input is disabled mid-run, but a drop would still swap the file
    // and reset the job state, orphaning the translation already in flight.
    if (this.busy()) return;
    this.selectFile(event.dataTransfer?.files?.[0] ?? null);
  }

  private selectFile(file: File | null): void {
    this.job.set({ phase: 'idle', progress: -1, message: '' });
    this.fileError.set(null);

    if (!file) {
      this.file.set(null);
      return;
    }

    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      this.file.set(null);
      this.fileError.set(`${ext || 'That file type'} is not supported by Azure Translator.`);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      this.file.set(null);
      this.fileError.set(
        `${formatBytes(file.size)} is over the ${formatBytes(MAX_FILE_BYTES)} limit.`
      );
      return;
    }

    this.file.set(file);
  }

  clearFile(): void {
    this.file.set(null);
    this.fileError.set(null);
    this.job.set({ phase: 'idle', progress: -1, message: '' });
  }

  // --- translation ----------------------------------------------------------

  async translate(): Promise<void> {
    const file = this.file();
    if (!file || this.busy()) return;

    this.job.set({ phase: 'preparing', progress: -1, message: 'Preparing upload...' });

    try {
      const result = await this.api.translate({
        file,
        targetLanguage: this.targetLanguage(),
        sourceLanguage: this.sourceLanguage() || undefined,
        onUploadProgress: (percent) =>
          this.job.set({
            phase: 'uploading',
            progress: percent,
            message: `Uploading ${file.name}...`,
          }),
        onPhase: (phase, progress) =>
          this.job.set({
            phase,
            progress,
            message:
              phase === 'starting'
                ? 'Starting the translation job...'
                : `Translating into ${this.targetLanguageName()}...`,
          }),
      });

      this.job.set({
        phase: 'done',
        progress: 100,
        message: `Translated into ${this.targetLanguageName()}.`,
        downloadUrl: result.downloadUrl,
        charactersCharged: result.charactersCharged,
      });
    } catch (err) {
      this.job.set({ phase: 'error', progress: -1, message: this.messageOf(err) });
    }
  }

  reset(): void {
    this.clearFile();
  }

  private messageOf(err: unknown): string {
    return err instanceof Error ? err.message : 'Something went wrong.';
  }
}

/** Used only if /api/languages is unreachable, so the UI still functions. */
const FALLBACK_LANGUAGES: Language[] = [
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', dir: 'rtl' },
  { code: 'zh-Hans', name: 'Chinese (Simplified)', nativeName: '中文', dir: 'ltr' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', dir: 'ltr' },
  { code: 'en', name: 'English', nativeName: 'English', dir: 'ltr' },
  { code: 'fr', name: 'French', nativeName: 'Français', dir: 'ltr' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', dir: 'ltr' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', dir: 'ltr' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', dir: 'ltr' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', dir: 'ltr' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', dir: 'ltr' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', dir: 'ltr' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', dir: 'ltr' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', dir: 'ltr' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', dir: 'ltr' },
];
