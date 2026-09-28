/* Presentation preferences: light/dark theme and the confirmation chime.
 *
 * No camera or identification dependencies. Preferences persist in localStorage (wrapped
 * in try/catch because storage can be blocked). The chime is synthesized with the Web
 * Audio API, two short oscillator notes, so no audio file needs to be downloaded, and
 * the AudioContext is created only after a user gesture as browsers require. */
(() => {
  const read = (key, fallback) => {
    try {
      return localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  };
  const save = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Storage is optional. */
    }
  };
  let theme = read("ucenth-theme", "dark") === "light" ? "light" : "dark";
  let sound = read("ucenth-sound", "on") !== "off";
  let context;
  let audioReady;
  let activeMaster;
    // Theme switching is one attribute on <html>; CSS custom properties do the rest.
  const applyTheme = () => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "light" ? "#f5f6f8" : "#101112");
  };
  applyTheme();
  document.addEventListener("DOMContentLoaded", () => {
    const themeButton = document.getElementById("theme-toggle");
    const soundButton = document.getElementById("sound-toggle");
    const updateControls = () => {
      themeButton?.setAttribute("aria-pressed", String(theme === "light"));
      soundButton?.setAttribute("aria-pressed", String(sound));
      if (themeButton)
        themeButton.title =
          theme === "dark"
            ? "Switch to light appearance"
            : "Switch to dark appearance";
      if (soundButton) {
        const label = sound
          ? "Mute interface sounds"
          : "Enable interface sounds";
        soundButton.title = label;
        soundButton.setAttribute("aria-label", label);
      }
    };
    updateControls();
    themeButton?.addEventListener("click", () => {
      theme = theme === "dark" ? "light" : "dark";
      save("ucenth-theme", theme);
      applyTheme();
      updateControls();
    });
    soundButton?.addEventListener("click", () => {
      sound = !sound;
      save("ucenth-sound", sound ? "on" : "off");
      updateControls();
      if (sound) ensureAudioReady();
      else if (activeMaster && context) {
        // Silence an in-flight cue too, without tearing down the reusable context.
        try {
          activeMaster.gain.setTargetAtTime(0, context.currentTime, 0.01);
        } catch {}
      }
    });
    // Create/unlock from input or unmute gestures; never create a context on page load.
    const ensureAudioReady = () => {
      try {
        const Audio = window.AudioContext || window.webkitAudioContext;
        if (!context && Audio) context = new Audio();
        audioReady = context?.resume().catch(() => {});
      } catch {
        /* Audio must never interrupt scanning. */
      }
    };
    for (const id of ["start", "reset", "upload"])
      document
        .getElementById(id)
        ?.addEventListener("click", ensureAudioReady, true);

    const announced = new WeakSet();
        // Play the chime for a confident identification and expose a promise that resolves
        // when it ends, so voice.js can start Charon's introduction right after it.
    document.addEventListener("ucenth:result-presented", ({ detail }) => {
      detail.chimeCompletion = Promise.resolve();
      const result = document.querySelector("#results .identity-name");
      if (!result || announced.has(result)) return;
      announced.add(result);
      if (
        !sound ||
        detail.needsAnotherView ||
        detail.status !== "hypothesis" ||
        !["high", "medium"].includes(detail.confidence) ||
        !context
      )
        return;
      // Re-attempt resume after a device interruption; never await audio in rendering.
      // The original click (including an unmute click) has already unlocked it.
      ensureAudioReady();
      // A 560 ms ascending pair with a soft harmonic, no downloaded audio assets.
      detail.chimeCompletion = Promise.resolve(audioReady)
        .then(() => {
          if (!sound || !result.isConnected || context.state !== "running")
            return;
          try {
            const start = context.currentTime;
            const master = context.createGain();
            activeMaster = master;
            master.gain.value = 0.14;
            master.connect(context.destination);
            const wave = context.createPeriodicWave(
              new Float32Array([0, 0, 0, 0]),
              new Float32Array([0, 1, 0.12, 0.035]),
            );
            let remaining = 2, finishChime;
            const completed = new Promise((resolve) => { finishChime = resolve; });
            for (const [offset, frequency, duration, level] of [
              [0, 554.37, 0.36, 0.62],
              [0.16, 698.46, 0.4, 0.56],
            ]) {
              const oscillator = context.createOscillator();
              const envelope = context.createGain();
              oscillator.setPeriodicWave(wave);
              oscillator.frequency.value = frequency;
              envelope.gain.setValueAtTime(0, start + offset);
              envelope.gain.linearRampToValueAtTime(
                level,
                start + offset + 0.028,
              );
              envelope.gain.exponentialRampToValueAtTime(
                0.0001,
                start + offset + duration,
              );
              oscillator.connect(envelope);
              envelope.connect(master);
              oscillator.onended = () => {
                oscillator.disconnect();
                envelope.disconnect();
                if (--remaining === 0) {
                  master.disconnect();
                  if (activeMaster === master) activeMaster = null;
                  finishChime();
                }
              };
              oscillator.start(start + offset);
              oscillator.stop(start + offset + duration);
            }
            return completed;
          } catch {
            /* Silent fallback if audio hardware or permissions are unavailable. */
          }
        })
        .catch(() => {});
    });
  });
})();
