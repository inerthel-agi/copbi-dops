// Keyboard by physical key (KeyboardEvent.code, so ZQSD on AZERTY maps to the WASD codes) and
// drag-to-look with pointer capture (the sandbox has no Pointer Lock). When the host keeps the iframe
// in-process, the captured pointer keeps turning outside the visual. Chrome puts sandbox="allow-scripts"
// iframes out of process, and then the iframe gets nothing while the pointer is outside, not even the
// release: the drag logic below must survive missing pointerup events.

const TAP_PX = 6, TAP_MS = 350;

export class Input {
    readonly down = new Set<string>();
    lookX = 0;
    lookY = 0;
    taps = 0;
    wheel = 0;
    aim = false;
    /** Left button held while aiming (right button down): browsers send no pointerdown for it, only a pointermove. */
    fireMouse = false;
    /** Pointer offset from the visual center, -1..1, while the pointer is over it (joystick look). */
    hoverX = 0;
    hoverY = 0;
    /** Capture mode: the first click engages, the cursor is hidden and mouse movement turns the view with no button held. */
    captureMode = false;
    engaged = false;
    /** True while the browser grants a real pointer lock (standalone page). Never true inside Power BI's sandbox. */
    locked = false;
    private leftWas = false;
    private reenter = false;
    private hits = new Set<string>();
    private drag: { id: number; x: number; y: number; sx: number; sy: number; t: number; last: number; far: boolean } | null = null;

    constructor(private el: HTMLElement, private onGesture: (pointer: boolean) => void) {
        el.tabIndex = 0;
        el.addEventListener("pointerdown", this.onDown);
        el.addEventListener("pointermove", this.onMove);
        el.addEventListener("pointerup", this.onUp);
        el.addEventListener("pointercancel", this.onUp);
        el.addEventListener("lostpointercapture", this.onLost);
        el.addEventListener("pointerleave", this.onLeave);
        document.documentElement.addEventListener("mouseleave", this.onLeave);
        document.addEventListener("pointerout", this.onOut);
        window.addEventListener("mouseout", this.onOut);
        el.addEventListener("contextmenu", this.prevent);
        el.addEventListener("wheel", this.onWheel, { passive: false });
        window.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("keyup", this.onKeyUp);
        window.addEventListener("blur", this.reset);
        document.addEventListener("pointerlockchange", this.onLock);
    }

    /** True once per key press (cleared by endFrame). */
    pressed(code: string): boolean {
        return this.hits.has(code);
    }

    endFrame(): void {
        this.hits.clear();
        this.lookX = this.lookY = this.taps = this.wheel = 0;
    }

    /** Ends the capture and gives the real cursor back. */
    release(): void {
        this.engaged = this.fireMouse = false;
        if (document.pointerLockElement === this.el) document.exitPointerLock();
    }

    private onLock = (): void => {
        this.locked = document.pointerLockElement === this.el;
        // Esc (browser-side) or any other loss of the lock: back to the free cursor.
        if (!this.locked) this.engaged = this.fireMouse = false;
    };

    reset = (): void => {
        if (document.pointerLockElement === this.el) document.exitPointerLock();
        this.down.clear();
        this.hits.clear();
        this.aim = this.fireMouse = this.engaged = this.leftWas = false;
        this.hoverX = this.hoverY = 0;
        this.drag = null;
        this.lookX = this.lookY = this.taps = this.wheel = 0;
    };

    dispose(): void {
        const el = this.el;
        el.removeEventListener("pointerdown", this.onDown);
        el.removeEventListener("pointermove", this.onMove);
        el.removeEventListener("pointerup", this.onUp);
        el.removeEventListener("pointercancel", this.onUp);
        el.removeEventListener("lostpointercapture", this.onLost);
        el.removeEventListener("pointerleave", this.onLeave);
        document.documentElement.removeEventListener("mouseleave", this.onLeave);
        document.removeEventListener("pointerout", this.onOut);
        window.removeEventListener("mouseout", this.onOut);
        el.removeEventListener("contextmenu", this.prevent);
        el.removeEventListener("wheel", this.onWheel);
        window.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("keyup", this.onKeyUp);
        window.removeEventListener("blur", this.reset);
        document.removeEventListener("pointerlockchange", this.onLock);
    }

    private prevent = (e: Event): void => e.preventDefault();

    private onDown = (e: PointerEvent): void => {
        // A click on a panel button must not resume or capture first: the button needs its own click.
        const onButton = !!(e.target as Element).closest("button, input");
        this.onGesture(!onButton);
        if (onButton) return;
        this.el.focus({ preventScroll: true });
        if (this.captureMode) {
            // The press that engages is not a shot.
            const engaging = !this.engaged;
            this.engaged = true;
            if (engaging) {
                // Real pointer lock when the host allows it (standalone page). Inside Power BI the sandbox rejects it
                // with a SecurityError and the capture falls back to the emulation below.
                try {
                    const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
                    p?.catch?.((): void => undefined);
                } catch { /* sandboxed */ }
                this.aim = (e.buttons & 2) !== 0;
                this.leftWas = (e.buttons & 1) !== 0;
                return;
            }
            this.buttons(e);
            return;
        }
        this.buttons(e);
        // A press always starts a fresh drag: the previous one may be stale (released outside the iframe).
        this.el.setPointerCapture(e.pointerId);
        this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: e.timeStamp, last: e.timeStamp, far: false };
    };

    private buttons(e: PointerEvent): void {
        const left = (e.buttons & 1) !== 0;
        this.aim = (e.buttons & 2) !== 0;
        if (this.captureMode) {
            // Left = fire with or without ADS. Browsers send no pointerdown for a second button: detect the press here.
            this.fireMouse = left && this.engaged;
            if (left && !this.leftWas && this.engaged) this.taps++;
        } else {
            this.fireMouse = this.aim && left;
        }
        this.leftWas = left;
    }

    /** pointerout / mouseout with no target to enter = the cursor left the iframe. */
    private onOut = (e: MouseEvent): void => {
        if (!e.relatedTarget) this.onLeave();
    };

    private onLeave = (): void => {
        this.hoverX = this.hoverY = 0;
        // The cursor left the visual (fast flick): stop turning but stay engaged, so coming back needs no click.
        // The capture only ends on focus loss (blur), pause, or the menu.
        this.fireMouse = false;
        this.reenter = true;
    };

    private onMove = (e: PointerEvent): void => {
        this.buttons(e);
        const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
        // Under a real lock clientX is frozen: the border band must not engage.
        this.hoverX = this.locked ? 0 : Math.max(-1, Math.min(1, (e.clientX - w / 2) / (w / 2)));
        this.hoverY = this.locked ? 0 : Math.max(-1, Math.min(1, (e.clientY - h / 2) / (h / 2)));
        if (this.captureMode) {
            // The first move after re-entering carries the whole distance travelled outside: drop it.
            if (this.engaged && !this.reenter && Math.abs(e.movementX) < 300 && Math.abs(e.movementY) < 300) {
                this.lookX += e.movementX;
                this.lookY += e.movementY;
            }
            this.reenter = false;
            return;
        }
        const d = this.drag;
        if (!d || d.id !== e.pointerId) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        // Silence then a jump = the pointer came back from outside an out-of-process iframe, where the
        // release may have happened unseen (buttons can be stale). End the drag; a new press resumes.
        if (e.buttons === 0 || (e.timeStamp - d.last > 250 && Math.abs(dx) + Math.abs(dy) > 40)) return this.endDrag(e.pointerId);
        this.lookX += dx;
        this.lookY += dy;
        d.x = e.clientX;
        d.y = e.clientY;
        d.last = e.timeStamp;
        if (Math.abs(d.x - d.sx) + Math.abs(d.y - d.sy) > TAP_PX) d.far = true;
    };

    private onUp = (e: PointerEvent): void => {
        if (this.captureMode) return this.buttons(e);
        this.aim = (e.buttons & 2) !== 0;
        const d = this.drag;
        if (!d || d.id !== e.pointerId) return;
        if (e.type === "pointerup" && e.button === 0 && !d.far && e.timeStamp - d.t < TAP_MS) this.taps++;
        this.buttons(e);
        if (e.buttons === 0) this.endDrag(e.pointerId);
    };

    private onLost = (e: PointerEvent): void => {
        if (this.drag?.id === e.pointerId) this.endDrag(e.pointerId);
    };

    private endDrag(id: number): void {
        this.drag = null;
        this.aim = this.fireMouse = false;
        if (this.el.hasPointerCapture(id)) this.el.releasePointerCapture(id);
    }

    private onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        this.wheel += Math.sign(e.deltaY);
    };

    private onKeyDown = (e: KeyboardEvent): void => {
        // Esc and function keys belong to Power BI (Esc moves focus back to the visual container).
        if (e.ctrlKey || e.metaKey || e.altKey || /^F\d/.test(e.code)) return;
        // Typing a class name: the text field gets every key, the game none.
        if (e.target instanceof HTMLInputElement) return;
        // Keep Tab/Space/digits inside the game instead of scrolling or moving focus.
        // Esc is read by the game (pause) but not blocked: Power BI keeps its own use of it.
        if (e.code !== "Escape") e.preventDefault();
        if (!e.repeat) this.hits.add(e.code);
        this.down.add(e.code);
        this.onGesture(false);
    };

    private onKeyUp = (e: KeyboardEvent): void => {
        this.down.delete(e.code);
    };
}
