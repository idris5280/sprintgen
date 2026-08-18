import { Color, Mesh, Program, Renderer, Triangle } from "/assets/vendor/ogl-lite.js?v=1";

// React Bits' Floating Lines shader is rendered with the artifact engine's
// existing OGL runtime so the presentation stays independent of React.

(function () {
  const root = document.querySelector(".reveal");
  const floatingLinesHost = document.querySelector("[data-floating-lines]");
  const iridescenceHost = document.querySelector("[data-iridescence]");
  const previousButton = document.querySelector("[data-spotlight-prev]");
  const nextButton = document.querySelector("[data-spotlight-next]");
  const fullscreenButton = document.querySelector("[data-fullscreen]");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!root || !window.Reveal) {
    document.body.classList.add(iridescenceHost ? "iridescence-fallback" : "floating-lines-fallback");
    return;
  }

  const slides = Array.from(root.querySelectorAll(".slides > section"));
  slides.forEach((slide, index) => {
    slide.id = slide.id || `slide-${index + 1}`;
  });

  if (/^#slide-\d+$/i.test(window.location.hash)) {
    history.replaceState(null, "", `#/${window.location.hash.slice(1)}`);
  }

  function setupFullscreen(button) {
    if (!button) return;

    const update = () => {
      const active = Boolean(document.fullscreenElement);
      button.setAttribute("aria-label", active ? "Exit full screen" : "Enter full screen");
      button.setAttribute("title", active ? "Exit full screen" : "Enter full screen");
      button.setAttribute("aria-pressed", String(active));
      const iconPath = button.querySelector("[data-fullscreen-icon]");
      if (iconPath) {
        iconPath.setAttribute("d", active ? iconPath.dataset.minimizePath : iconPath.dataset.maximizePath);
      }
    };

    button.addEventListener("click", async () => {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen?.();
        } else {
          await document.documentElement.requestFullscreen?.();
        }
      } catch (error) {
        console.warn("Fullscreen is unavailable in this browser.", error);
      }
    });
    document.addEventListener("fullscreenchange", update);
    update();
  }

  function formatMetricValue(element, value) {
    const prefix = element.getAttribute("data-count-prefix") || "";
    const suffix = element.getAttribute("data-count-suffix") || "";
    const decimals = Math.max(0, Math.min(2, Number(element.getAttribute("data-count-decimals") || 0)));
    return `${prefix}${Number(value).toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    })}${suffix}`;
  }

  function playMetricCounts(slide) {
    slide.querySelectorAll("[data-count-target]").forEach((element, index) => {
      const target = Number(element.getAttribute("data-count-target") || 0);
      if (!Number.isFinite(target) || reducedMotion) {
        element.textContent = formatMetricValue(element, Number.isFinite(target) ? target : 0);
        return;
      }

      const duration = 900;
      const delay = Math.min(index * 90, 270);
      let startedAt = 0;
      element.textContent = formatMetricValue(element, 0);

      window.setTimeout(() => {
        const frame = (now) => {
          if (!startedAt) startedAt = now;
          const progress = Math.min((now - startedAt) / duration, 1);
          const eased = 1 - Math.pow(1 - progress, 3);
          element.textContent = formatMetricValue(element, target * eased);
          if (progress < 1) window.requestAnimationFrame(frame);
        };
        window.requestAnimationFrame(frame);
      }, delay);
    });
  }

  function playVelocity(slide) {
    slide.querySelectorAll(".velocity-fill").forEach((fill, index) => {
      fill.getAnimations().forEach((animation) => animation.cancel());
      if (reducedMotion) {
        fill.style.transform = "scaleX(1)";
        return;
      }
      fill.animate(
        [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
        { duration: 1050, delay: index * 100, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "forwards" }
      );
    });
  }

  function playBurndown(slide) {
    slide.querySelectorAll(".burn-line").forEach((line) => {
      if (typeof line.getTotalLength !== "function") return;
      const length = Math.max(line.getTotalLength(), 1);
      line.getAnimations().forEach((animation) => animation.cancel());
      line.style.strokeDasharray = `${length} ${length}`;
      if (reducedMotion) {
        line.style.strokeDashoffset = "0";
        return;
      }
      line.animate(
        [{ strokeDashoffset: length }, { strokeDashoffset: 0 }],
        { duration: 2200, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "forwards" }
      );
    });

    slide.querySelectorAll(".burn-dot, .burn-outcome-marker").forEach((marker, index) => {
      marker.getAnimations().forEach((animation) => animation.cancel());
      if (reducedMotion) {
        marker.style.opacity = "1";
        return;
      }
      marker.animate(
        [{ opacity: 0, transform: "scale(.82)" }, { opacity: 1, transform: "scale(1)" }],
        { duration: 360, delay: 300 + index * 160, easing: "ease-out", fill: "forwards" }
      );
    });
  }

  function playSlideEffects(slide) {
    if (!slide) return;
    playMetricCounts(slide);
    playVelocity(slide);
    playBurndown(slide);
  }

  function setupFloatingLines(container) {
    if (!container || reducedMotion) {
      document.body.classList.add("floating-lines-fallback");
      return () => {};
    }

    let renderer;
    let animationFrame = 0;
    let stopped = false;
    let lastFrame = 0;
    const frameInterval = 1000 / 60;

    try {
      renderer = new Renderer({
        dpr: Math.min(window.devicePixelRatio || 1, 1.25),
        alpha: true
      });
      const gl = renderer.gl;
      gl.canvas.setAttribute("aria-hidden", "true");
      gl.canvas.style.width = "100%";
      gl.canvas.style.height = "100%";
      container.replaceChildren(gl.canvas);

      const geometry = new Triangle(gl);
      const program = new Program(gl, {
        vertex: `
          attribute vec2 position;
          void main() {
            gl_Position = vec4(position, 0.0, 1.0);
          }
        `,
        fragment: `
          precision highp float;

          uniform float iTime;
          uniform vec3 iResolution;
          uniform float animationSpeed;
          uniform float bendRadius;
          uniform float bendStrength;
          uniform vec2 parallaxOffset;

          const float LINE_DISTANCE = 0.505;
          const float INTERACTIVE = 0.0;
          const float PARALLAX = 1.0;
          const vec3 GRADIENT_START = vec3(68.0, 72.0, 242.0) / 255.0;
          const vec3 GRADIENT_MID = vec3(111.0, 111.0, 111.0) / 255.0;
          const vec3 GRADIENT_END = vec3(106.0, 106.0, 106.0) / 255.0;

          mat2 rotate(float radians) {
            return mat2(cos(radians), sin(radians), -sin(radians), cos(radians));
          }

          float wave(vec2 uv, float offset) {
            float time = iTime * animationSpeed;
            float xOffset = offset;
            float xMovement = time * 0.1;
            float amplitude = sin(offset + time * 0.2) * 0.3;
            float y = sin(uv.x + xOffset + xMovement) * amplitude;

            if (INTERACTIVE > 0.5) {
              vec2 mouseUv = vec2(0.0);
              vec2 d = uv - mouseUv;
              float influence = exp(-dot(d, d) * bendRadius);
              y += (mouseUv.y - uv.y) * influence * bendStrength;
            }

            float distanceToWave = uv.y - y;
            return 0.0175 / max(abs(distanceToWave) + 0.01, 0.001) + 0.01;
          }

          void main() {
            vec2 baseUv = (2.0 * gl_FragCoord.xy - iResolution.xy) / iResolution.y;
            baseUv.y *= -1.0;
            if (PARALLAX > 0.5) baseUv += parallaxOffset;

            vec3 color = vec3(0.0);

            float bottomAngle = -1.0 * log(length(baseUv) + 1.0);
            vec2 bottomUv = baseUv * rotate(bottomAngle);
            color += GRADIENT_END * wave(bottomUv + vec2(LINE_DISTANCE * 0.0 + 2.0, -0.7), 1.5) * 0.2;

            float middleAngle = 0.2 * log(length(baseUv) + 1.0);
            vec2 middleUv = baseUv * rotate(middleAngle);
            color += GRADIENT_MID * wave(middleUv + vec2(LINE_DISTANCE * 0.0 + 5.0, 0.0), 2.0);

            float topAngle = -0.4 * log(length(baseUv) + 1.0);
            vec2 topUv = baseUv * rotate(topAngle);
            topUv.x *= -1.0;
            color += GRADIENT_START * wave(topUv + vec2(LINE_DISTANCE * 0.0 + 10.0, 0.5), 1.0) * 0.1;

            float intensity = max(max(color.r, color.g), color.b);
            float alpha = clamp(intensity * 2.2, 0.0, 0.9);
            vec3 visibleColor = color / max(intensity, 0.001);
            gl_FragColor = vec4(visibleColor, alpha);
          }
        `,
        uniforms: {
          iTime: { value: 0 },
          iResolution: { value: new Color(1, 1, 1) },
          animationSpeed: { value: 1 },
          bendRadius: { value: 9 },
          bendStrength: { value: -4 },
          parallaxOffset: { value: new Float32Array([0, 0]) }
        },
        transparent: true,
        depthTest: false,
        depthWrite: false
      });
      const mesh = new Mesh(gl, { geometry, program });

      const resize = () => {
        const width = Math.max(container.clientWidth, 1);
        const height = Math.max(container.clientHeight, 1);
        renderer.dpr = Math.min(window.devicePixelRatio || 1, 1.25);
        renderer.setSize(width, height);
        const pixelWidth = width * renderer.dpr;
        const pixelHeight = height * renderer.dpr;
        program.uniforms.iResolution.value = new Color(pixelWidth, pixelHeight, pixelWidth / Math.max(pixelHeight, 1));
      };

      const renderFrame = (time) => {
        if (stopped) return;
        animationFrame = window.requestAnimationFrame(renderFrame);
        if (document.hidden) return;
        const elapsed = time - lastFrame;
        if (elapsed < frameInterval) return;
        lastFrame = time - (elapsed % frameInterval);
        program.uniforms.iTime.value = time * 0.001;
        renderer.render({ scene: mesh });
        container.classList.add("is-ready");
      };

      window.addEventListener("resize", resize);
      gl.canvas.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        document.body.classList.add("floating-lines-fallback");
        container.classList.remove("is-ready");
      });
      resize();
      animationFrame = window.requestAnimationFrame(renderFrame);

      return () => {
        stopped = true;
        window.cancelAnimationFrame(animationFrame);
        window.removeEventListener("resize", resize);
        try {
          renderer.gl.getExtension("WEBGL_lose_context")?.loseContext();
        } catch (error) {
          console.warn("Floating Lines WebGL cleanup was incomplete.", error);
        }
        container.replaceChildren();
      };
    } catch (error) {
      console.warn("Floating Lines are unavailable; using the static background.", error);
      document.body.classList.add("floating-lines-fallback");
      return () => {};
    }
  }

  function setupIridescence(container) {
    if (!container || reducedMotion) {
      document.body.classList.add("iridescence-fallback");
      return () => {};
    }

    let renderer;
    let animationFrame = 0;
    let stopped = false;
    let lastFrame = 0;
    const frameInterval = 1000 / 60;

    try {
      renderer = new Renderer({
        dpr: Math.min(window.devicePixelRatio || 1, 1.25),
        alpha: false
      });
      const gl = renderer.gl;
      gl.clearColor(0.0235, 0.7137, 0.8314, 1);
      gl.canvas.setAttribute("aria-hidden", "true");
      gl.canvas.style.width = "100%";
      gl.canvas.style.height = "100%";
      container.replaceChildren(gl.canvas);

      const geometry = new Triangle(gl);
      const program = new Program(gl, {
        vertex: `
          attribute vec2 uv;
          attribute vec2 position;
          varying vec2 vUv;

          void main() {
            vUv = uv;
            gl_Position = vec4(position, 0.0, 1.0);
          }
        `,
        fragment: `
          precision highp float;

          uniform float uTime;
          uniform vec3 uColor;
          uniform vec3 uResolution;
          uniform vec2 uMouse;
          uniform float uAmplitude;
          uniform float uSpeed;

          varying vec2 vUv;

          void main() {
            float mr = min(uResolution.x, uResolution.y);
            vec2 uv = (vUv.xy * 2.0 - 1.0) * uResolution.xy / mr;

            uv += (uMouse - vec2(0.5)) * uAmplitude;

            float d = -uTime * 0.5 * uSpeed;
            float a = 0.0;
            for (float i = 0.0; i < 8.0; ++i) {
              a += cos(i - d - a * uv.x);
              d += sin(uv.y * i + a);
            }
            d += uTime * 0.5 * uSpeed;
            vec3 col = vec3(cos(uv * vec2(d, a)) * 0.6 + 0.4, cos(a + d) * 0.5 + 0.5);
            col = cos(col * cos(vec3(d, a, 2.5)) * 0.5 + 0.5) * uColor;
            gl_FragColor = vec4(col, 1.0);
          }
        `,
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: new Color(6 / 255, 182 / 255, 212 / 255) },
          uResolution: { value: new Color(1, 1, 1) },
          uMouse: { value: new Float32Array([0.5, 0.5]) },
          uAmplitude: { value: 0.1 },
          uSpeed: { value: 0.3 }
        },
        transparent: false,
        depthTest: false,
        depthWrite: false
      });
      const mesh = new Mesh(gl, { geometry, program });

      const resize = () => {
        const width = Math.max(container.clientWidth, 1);
        const height = Math.max(container.clientHeight, 1);
        renderer.dpr = Math.min(window.devicePixelRatio || 1, 1.25);
        renderer.setSize(width, height);
        program.uniforms.uResolution.value = new Color(
          gl.canvas.width,
          gl.canvas.height,
          gl.canvas.width / Math.max(gl.canvas.height, 1)
        );
      };

      const renderFrame = (time) => {
        if (stopped) return;
        animationFrame = window.requestAnimationFrame(renderFrame);
        if (document.hidden) return;
        const elapsed = time - lastFrame;
        if (elapsed < frameInterval) return;
        lastFrame = time - (elapsed % frameInterval);
        program.uniforms.uTime.value = time * 0.001;
        renderer.render({ scene: mesh });
        container.classList.add("is-ready");
      };

      const handleContextLoss = (event) => {
        event.preventDefault();
        document.body.classList.add("iridescence-fallback");
        container.classList.remove("is-ready");
      };

      window.addEventListener("resize", resize);
      gl.canvas.addEventListener("webglcontextlost", handleContextLoss);
      resize();
      animationFrame = window.requestAnimationFrame(renderFrame);

      return () => {
        stopped = true;
        window.cancelAnimationFrame(animationFrame);
        window.removeEventListener("resize", resize);
        gl.canvas.removeEventListener("webglcontextlost", handleContextLoss);
        try {
          renderer.gl.getExtension("WEBGL_lose_context")?.loseContext();
        } catch (error) {
          console.warn("Iridescence WebGL cleanup was incomplete.", error);
        }
        container.replaceChildren();
      };
    } catch (error) {
      console.warn("Iridescence is unavailable; using the static background.", error);
      document.body.classList.add("iridescence-fallback");
      return () => {};
    }
  }

  setupFullscreen(fullscreenButton);
  const stopPresentationBackground = iridescenceHost
    ? setupIridescence(iridescenceHost)
    : setupFloatingLines(floatingLinesHost);

  const deck = new window.Reveal(root, {
    width: "100%",
    height: "100%",
    margin: 0,
    minScale: 1,
    maxScale: 1,
    controls: false,
    progress: true,
    slideNumber: false,
    hash: true,
    history: false,
    respondToHashChanges: true,
    center: false,
    touch: true,
    keyboard: true,
    overview: true,
    transition: reducedMotion ? "none" : "concave",
    transitionSpeed: "default",
    backgroundTransition: reducedMotion ? "none" : "fade",
    scrollActivationWidth: 0
  });

  function updateControls() {
    previousButton?.toggleAttribute("disabled", deck.isFirstSlide());
    nextButton?.toggleAttribute("disabled", deck.isLastSlide());
  }

  previousButton?.addEventListener("click", () => deck.prev());
  nextButton?.addEventListener("click", () => deck.next());
  deck.on("slidechanged", (event) => {
    updateControls();
    playSlideEffects(event.currentSlide);
  });
  deck.initialize().then(() => {
    updateControls();
    playSlideEffects(deck.getCurrentSlide());
  }).catch((error) => {
    console.error("Presentation mode could not initialize Reveal.js.", error);
    document.body.classList.add(iridescenceHost ? "iridescence-fallback" : "floating-lines-fallback");
  });

  window.addEventListener("pagehide", stopPresentationBackground, { once: true });
})();
