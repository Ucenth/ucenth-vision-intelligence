/* Audio-reactive particle presence.
 *
 *   microphone or Charon playback → Web Audio AnalyserNode
 *     → time-domain samples (loudness) + frequency bins (bass / voice / air bands)
 *     → four smoothed values in a vec4 uniform → vertex shader deforms a sphere of points
 *
 * The particles are driven by the real audio signal, not by a canned animation. The
 * geometry is a fixed Fibonacci sphere uploaded once; every frame the GPU moves each
 * point according to the audio bands and time, so drawing 12,000 points costs almost
 * nothing on the CPU. A Canvas 2D fallback keeps a genuine loudness response when
 * WebGL2 is unavailable. The reviewed standalone point buffer, shaders and deformation
 * are retained verbatim; this adapter supplies lifecycle and audio input. */
/* The reviewed standalone point buffer, shaders and deformation are retained verbatim.
 * This adapter supplies lifecycle/audio input from the scanner conversation. */
export function createParticlePresence(
  host,
  { onActivity = () => {}, onMetrics = () => {}, onFallback = () => {} } = {},
) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  const fallbackHost = document.createElement("div");
  fallbackHost.className = "particle-fallback";
  fallbackHost.hidden = true;
  host.replaceChildren(canvas, fallbackHost);
  const motion = matchMedia("(prefers-reduced-motion: reduce)"),
    mobile = matchMedia("(max-width:720px)");
  // Quality decisions are made once from the environment: reduced-motion preference,
  // low-power heuristics (few cores or little memory) and a mobile-width media query.
  const settings = {
    reduced: motion.matches,
    low: navigator.hardwareConcurrency <= 4 || navigator.deviceMemory <= 4,
    paused: false,
  };
  let analyser,
    context,
    timeData,
    freqData,
    activeSource = "none",
    noise = 0.002,
    listenStarted = 0,
    voiceUntil = 0,
    thinking = false;
  let raw = [0, 0, 0, 0],
    smooth = [0, 0, 0, 0],
    stateMix = 0,
    lastDraw = 0,
    nextDraw = 0,
    phase = 0,
    lastMetrics = 0,
    drawCount = 0;
  let raf,
    gl,
    program,
    vao,
    buffer,
    uniforms = {},
    queryExt,
    queries = [],
    fallback,
    forceFallback = false;
  let gpuTimes = [],
    frameTimes = [],
    cpuTimes = [],
    levels = [],
    history = [],
    maxRms = 0,
    points = 12000,
    limit = 12000,
    quality = "high",
    slowFrames = 0,
    disposed = false;
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const percentile = (a, p) =>
    a.length ? a.toSorted((a, b) => a - b)[Math.floor((a.length - 1) * p)] : 0;
  // Metrics for tests and tuning: frame rate, CPU/GPU time percentiles and audio peaks.
  function snapshot() {
    return {
      fps:
        1000 /
        (frameTimes.reduce((a, b) => a + b, 0) /
          Math.max(1, frameTimes.length)),
      cpuP95: percentile(cpuTimes, 0.95),
      gpuP95: percentile(gpuTimes, 0.95),
      gpuTimerAvailable: !!queryExt,
      particles: gl ? points : 180,
      quality,
      reduced: settings.reduced,
      renderer: gl ? "WebGL2" : "Canvas2D",
      source: activeSource,
      maxRms,
      disposed,
    };
  }
  // Reads the analyser every frame. RMS (root mean square) of the waveform is overall
  // loudness. Three frequency bands are integrated from the dB spectrum: bass (70–260 Hz),
  // voice (260–2500 Hz, where speech energy lives) and air (2.5–8.5 kHz, consonants and
  // sibilance). The microphone path also runs a simple noise gate: the first 450 ms after
  // the mic opens measures the room's noise floor, and only levels clearly above it count
  // as "speaking" for the onActivity callback.
  function readAudio(now) {
    if (!analyser) {
      raw = [0, 0, 0, 0];
      return;
    }
    // how-to:start audio-analysis
    analyser.getFloatTimeDomainData(timeData);
    analyser.getFloatFrequencyData(freqData);
    let sum = 0;
    for (const v of timeData) sum += v * v;
    const rms = Math.sqrt(sum / timeData.length);
    maxRms = Math.max(maxRms, rms);
    const band = (lo, hi) => {
      const hz = context.sampleRate / analyser.fftSize;
      let sum = 0,
        n = 0;
      for (
        let i = Math.ceil(lo / hz);
        i < Math.min(freqData.length, Math.floor(hi / hz));
        i++
      ) {
        sum += Math.pow(10, freqData[i] / 10);
        n++;
      }
      return Math.sqrt(sum / Math.max(n, 1));
    };
    const gain = activeSource === "microphone" ? 2.5 : 1;
    raw = [
      clamp(rms * 6 * gain),
      clamp(band(70, 260) * 14 * gain),
      clamp(band(260, 2500) * 25 * gain),
      clamp(band(2500, 8500) * 42 * gain),
    ];
    // how-to:end audio-analysis
    if (activeSource === "microphone") {
      if (now - listenStarted < 450)
        noise = Math.min(0.006, noise * 0.95 + rms * 0.05);
      if (rms > Math.max(0.008, noise * 2.8)) voiceUntil = now + 400;
      onActivity(now < voiceUntil);
    }
  }
  // Vertex shader (runs on the GPU for every point, every frame).
  //   uAudio = [energy, bass, voice, air]; sqrt() flattens loud peaks so quiet speech
  //   still moves the field. Three sine "flows" at different spatial frequencies give
  //   broad swell (bass), rolling folds (voice) and fine shimmer (air). Shear, twist and
  //   a gentle rotation make speech fold the sphere rather than merely inflate it, and a
  //   soft clamp keeps the shape inside the stage. Colour and alpha depend on depth so the
  //   near side reads brighter.
  const vertex = `#version 300 es
precision highp float;
layout(location=0) in vec4 aPoint;
uniform float uTime,uAspect,uDpr,uHeight,uMotion,uThink;
uniform vec4 uAudio;
out vec3 vColor;out float vAlpha;
void main(){
 vec3 p=aPoint.xyz;vec3 n=normalize(p);float t=uTime;
 float bass=sqrt(uAudio.y),voice=sqrt(uAudio.z),air=sqrt(uAudio.w),energy=uAudio.x;
 float broad=sin(n.x*3.1+n.y*2.0+t*.65)*cos(n.z*2.7-t*.4);
 float flow=sin(n.y*6.0+n.x*3.0-t*1.1)*cos(n.z*4.0+t*.6);
 float fine=sin(n.x*25.0+n.z*17.0+t*2.1)*sin(n.y*19.0-t*1.7);
 float base=.055*sin(n.y*4.0+n.z*3.0+t*.23)+.035*cos(n.x*5.0-t*.18);
 float deformation=base+uMotion*(bass*.52*broad+voice*.38*flow+air*.11*fine);
 float breath=uMotion*.008*sin(t*.75);
 p*=1.0+deformation+breath+energy*mix(.025,.09,uMotion);
 // Spatially varying shear and twist: real speech folds the field, not just its radius.
 float bend=uMotion*(energy*.32+bass*.22);
 p.x+=bend*sin(n.y*2.3+t*.65)+uMotion*.025*sin(n.y*3.0+t*.2);
 p.y+=uMotion*voice*.22*sin(n.x*3.4-t*.7);
 float twist=uMotion*(voice*1.6+energy*.32)*sin(n.y*2.2+t*.4);
 p.xz=mat2(cos(twist),-sin(twist),sin(twist),cos(twist))*p.xz;
 p.x*=1.0+uMotion*energy*.16*sin(t*.8);
 p.y*=1.0-uMotion*energy*.1*sin(t*.8);
 p/=1.0+max(length(p)-1.35,0.0)*.55;
 float angle=t*(.024+uThink*.032)*uMotion;
 mat3 rot=mat3(cos(angle),0.,sin(angle),0.,1.,0.,-sin(angle),0.,cos(angle));p=rot*p;
 float tilt=-.15;p.yz=mat2(cos(tilt),-sin(tilt),sin(tilt),cos(tilt))*p.yz;
 float depth=3.7-p.z;vec2 xy=p.xy*2.1/depth;xy.x/=uAspect;
 gl_Position=vec4(xy,0.,1.);
 float nearSide=clamp((p.z+1.1)/2.2,0.,1.);
 gl_PointSize=(.85+nearSide*.7+aPoint.w*.22)*uDpr*clamp(uHeight/294.,.72,1.25);
 vec3 blue=vec3(.38,.58,.93),neutral=vec3(.79,.85,.94);
 float highlight=pow(max(0.,dot(n,normalize(vec3(-.5,.8,.8)))),6.0)*.55;
 vColor=mix(blue,neutral,highlight);
 vAlpha=(.13+.72*nearSide)*(.78+.22*aPoint.w)*(1.0+uAudio.x*.35);
}`;
  // Fragment shader: each point is a soft disc (discard outside the radius, smooth edge).
  const fragment = `#version 300 es
precision highp float;in vec3 vColor;in float vAlpha;out vec4 outColor;
void main(){float r=length(gl_PointCoord-.5);if(r>.5)discard;float a=(1.-smoothstep(.23,.5,r))*vAlpha;outColor=vec4(vColor,a);}`;
  // Canvas 2D fallback: a spiral of discs whose size follows loudness. Less beautiful,
  // but still honest to the real audio level.
  function activateFallback() {
    gl = null;
    canvas.hidden = true;
    fallbackHost.hidden = false;
    fallback = document.createElement("canvas");
    fallback.width = 440;
    fallback.height = 360;
    fallbackHost.replaceChildren(fallback);
    onFallback();
  }
  // WebGL2 setup: compile shaders, upload the fixed Fibonacci-sphere geometry once, and
  // look up uniforms. Any failure (no WebGL, shader error) falls back rather than crashing.
  function init() {
    try {
      if (forceFallback) throw Error("Requested fallback");
      gl = canvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        depth: false,
        powerPreference: "low-power",
        preserveDrawingBuffer: false,
      });
      if (!gl) throw Error("No WebGL");
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
          throw Error(gl.getShaderInfoLog(s));
        return s;
      };
      const vs = compile(gl.VERTEX_SHADER, vertex),
        fs = compile(gl.FRAGMENT_SHADER, fragment);
      program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw Error("Shader linking failed");
      gl.useProgram(program);
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const positions = new Float32Array(limit * 4);
      for (let i = 0; i < limit; i++) {
        const k = (i * 7919) % limit;
        const y = 1 - (2 * (k + 0.5)) / limit;
        const angle = k * Math.PI * (3 - Math.sqrt(5));
        const r = Math.sqrt(1 - y * y);
        const layer = 0.94 + 0.06 * Math.sin(k * 1.723);
        positions.set(
          [
            Math.cos(angle) * r * layer,
            y * layer,
            Math.sin(angle) * r * layer,
            (Math.sin(k * 45.1) + 1) / 2,
          ],
          i * 4,
        );
      }
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
      for (const name of [
        "uTime",
        "uAspect",
        "uDpr",
        "uHeight",
        "uMotion",
        "uThink",
        "uAudio",
      ])
        uniforms[name] = gl.getUniformLocation(program, name);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      queryExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    } catch (e) {
      console.warn(
        "Particle WebGL unavailable; using audio-reactive fallback.",
        e.message,
      );
      activateFallback();
    }
  }
  // Device pixel ratio is capped per quality tier; particle count and frame-rate target
  // follow reduced-motion, low-power and mobile settings.
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(
      devicePixelRatio,
      settings.low ? 1 : mobile.matches ? 1.25 : 1.5,
    );
    if (gl) {
      const width = Math.max(1, Math.round(rect.width * dpr)),
        height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    points = settings.reduced
      ? 1800
      : settings.low
        ? 3600
        : mobile.matches
          ? 6000
          : 12000;
    quality = settings.low ? "low" : mobile.matches ? "mobile" : "high";
  }
  function drawFallback() {
    const c = fallback.getContext("2d");
    c.clearRect(0, 0, 440, 360);
    for (let i = 0; i < 180; i++) {
      const a = i * 2.39996;
      const r = Math.sqrt(i / 180) * 130;
      const x = 220 + Math.cos(a) * r,
        y = 170 + Math.sin(a) * r * 0.84;
      c.fillStyle = `rgba(125,164,241,${0.25 + smooth[0] * 0.7})`;
      c.beginPath();
      c.arc(
        x,
        y,
        1.4 + smooth[0] * (settings.reduced ? 0.4 : 1.7),
        0,
        Math.PI * 2,
      );
      c.fill();
    }
  }
  // Frame loop. The target frame rate (60 desktop, 30 mobile/low-power, 20 reduced motion)
  // is enforced by skipping frames. Audio values are smoothed with fast attack and slower
  // release so movement feels responsive but relaxes gently in silence. If frames run
  // slow for a while the renderer demotes itself to the low tier automatically.
  function draw(now) {
    raf = requestAnimationFrame(draw);
    const target = settings.reduced
      ? 20
      : settings.low || mobile.matches
        ? 30
        : 60;
    const interval = 1000 / target;
    if (document.hidden || now < nextDraw - 0.1) return;
    nextDraw =
      nextDraw && now - nextDraw < 200 ? nextDraw + interval : now + interval;
    if (settings.paused) {
      readAudio(now);
      lastDraw = now;
      return;
    }
    const dt = lastDraw ? Math.min((now - lastDraw) / 1000, 0.1) : 1 / 60;
    if (lastDraw && now - lastDraw < 250) {
      frameTimes.push(now - lastDraw);
      if (frameTimes.length > 900) frameTimes.shift();
    }
    lastDraw = now;
    const start = performance.now();
    readAudio(now);
    for (let i = 0; i < 4; i++) {
      const tau = raw[i] > smooth[i] ? 0.075 : 0.24;
      smooth[i] += (raw[i] - smooth[i]) * (1 - Math.exp(-dt / tau));
    }
    stateMix += ((thinking ? 1 : 0) - stateMix) * (1 - Math.exp(-dt / 0.65));
    if (!settings.reduced) phase += dt;
    if (gl) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      const rect = canvas.getBoundingClientRect();
      gl.uniform1f(uniforms.uTime, settings.reduced ? 0 : phase);
      gl.uniform1f(uniforms.uAspect, rect.width / Math.max(1, rect.height));
      gl.uniform1f(uniforms.uDpr, canvas.width / Math.max(1, rect.width));
      gl.uniform1f(uniforms.uHeight, rect.height);
      gl.uniform1f(uniforms.uMotion, settings.reduced ? 0 : 1);
      gl.uniform1f(uniforms.uThink, stateMix);
      gl.uniform4fv(uniforms.uAudio, smooth);
      let q;
      if (queryExt && drawCount % 20 === 0 && queries.length < 4) {
        q = gl.createQuery();
        gl.beginQuery(queryExt.TIME_ELAPSED_EXT, q);
      }
      gl.drawArrays(gl.POINTS, 0, points);
      if (q) {
        gl.endQuery(queryExt.TIME_ELAPSED_EXT);
        queries.push(q);
      }
      if (queryExt) {
        const disjoint = gl.getParameter(queryExt.GPU_DISJOINT_EXT);
        while (
          queries.length &&
          gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)
        ) {
          const item = queries.shift();
          if (!disjoint) {
            gpuTimes.push(gl.getQueryParameter(item, gl.QUERY_RESULT) / 1e6);
            if (gpuTimes.length > 200) gpuTimes.shift();
          }
          gl.deleteQuery(item);
        }
      }
    } else drawFallback();
    cpuTimes.push(performance.now() - start);
    if (cpuTimes.length > 900) cpuTimes.shift();
    drawCount++;
    if (
      !settings.low &&
      !settings.reduced &&
      frameTimes.length > 120 &&
      dt > 0.035
    ) {
      slowFrames++;
      if (slowFrames > 90) {
        settings.low = true;
        resize();
      }
    } else slowFrames = Math.max(0, slowFrames - 1);
    if (now - lastMetrics > 1000) {
      lastMetrics = now;
      onMetrics(snapshot());
    }
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  const preferenceChanged = () => {
    settings.reduced = motion.matches;
    resize();
  };
  motion.addEventListener("change", preferenceChanged);
  const lost = (e) => {
    e.preventDefault();
    if (!disposed) activateFallback();
  };
  canvas.addEventListener("webglcontextlost", lost);
  init();
  resize();
  raf = requestAnimationFrame(draw);
  return {
    setState(state) {
      thinking = state === "THINKING";
    },
    // Attach an AnalyserNode (microphone or Charon output) and reset the noise gate.
    connect(node, source) {
      analyser = node;
      context = node.context;
      timeData = new Float32Array(node.fftSize);
      freqData = new Float32Array(node.frequencyBinCount);
      activeSource = source;
      noise = 0.002;
      listenStarted = performance.now();
      voiceUntil = 0;
    },
    disconnect() {
      analyser = null;
      context = null;
      activeSource = "none";
      raw = [0, 0, 0, 0];
    },
    snapshot,
    // Free GPU buffers, observers and the animation loop when the conversation ends.
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      motion.removeEventListener("change", preferenceChanged);
      canvas.removeEventListener("webglcontextlost", lost);
      analyser = null;
      context = null;
      if (gl) {
        queries.forEach((q) => gl.deleteQuery(q));
        gl.deleteBuffer(buffer);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(program);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
      host.replaceChildren();
    },
  };
}
