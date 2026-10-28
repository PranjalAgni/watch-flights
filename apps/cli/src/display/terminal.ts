const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[?25l";
const LEAVE_ALT_SCREEN = "\x1b[?25h\x1b[?1049l";

/**
 * Redraws whole frames in place on an alternate screen, restoring the terminal
 * on exit.
 */
export class InteractiveScreen {
  #active = false;
  #lastFrame = "";

  constructor(private readonly out: NodeJS.WritableStream) {}

  enter(): void {
    if (this.#active) return;
    this.#active = true;
    this.out.write(ENTER_ALT_SCREEN);
  }

  draw(frame: string): void {
    if (!this.#active || frame === this.#lastFrame) return;
    this.#lastFrame = frame;
    this.out.write(`\x1b[H${frame.split("\n").join("\x1b[K\n")}\x1b[K\x1b[J`);
  }

  /**
   * Forces the next draw even if the frame is unchanged (e.g. after a resize).
   */
  invalidate(): void {
    this.#lastFrame = "";
  }

  exit(): void {
    if (!this.#active) return;
    this.#active = false;
    this.out.write(LEAVE_ALT_SCREEN);
  }
}
