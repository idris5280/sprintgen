(function () {
  const slides = Array.from(document.querySelectorAll(".ado-present-slide"));
  const progress = document.querySelector(".present-progress span");
  const nextButton = document.querySelector("[data-next]");
  const prevButton = document.querySelector("[data-prev]");
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let activeSlideIndex = -1;

  if (slides.length === 0) {
    return;
  }

  slides.forEach((slide, index) => {
    slide.id = slide.id || `slide-${index + 1}`;
  });

  function setupBurndownAnimations() {
    const cards = Array.from(document.querySelectorAll(".burndown-hero-card"));

    cards.forEach((card) => {
      const line = card.querySelector(".burn-line");
      const dots = Array.from(card.querySelectorAll(".burn-dot"));

      if (!line || typeof line.getTotalLength !== "function") {
        return;
      }

      let pathLength = 1;

      try {
        line.removeAttribute("pathLength");
        pathLength = Math.max(line.getTotalLength(), 1);
      } catch (error) {
        pathLength = 1;
      }

      card.classList.add("js-burndown");
      line.style.setProperty("--burn-path-length", pathLength);
      line.style.strokeDasharray = `${pathLength} ${pathLength}`;
      line.style.strokeDashoffset = pathLength;

      dots.forEach((dot, index) => {
        const ratio = dots.length <= 1 ? 1 : index / (dots.length - 1);
        dot.style.setProperty("--burn-dot-delay", `${Math.max(.12, ratio * 2.85).toFixed(2)}s`);
      });

      card.playBurndown = function playBurndown() {
        if (card.burnAnimationFrame) {
          window.cancelAnimationFrame(card.burnAnimationFrame);
        }

        if (prefersReducedMotion) {
          line.style.strokeDashoffset = 0;
          dots.forEach((dot) => {
            dot.style.opacity = 1;
            dot.style.transform = "scale(1)";
          });
          return;
        }

        card.classList.remove("is-burn-active");
        line.style.strokeDashoffset = pathLength;

        dots.forEach((dot) => {
          dot.style.opacity = "";
          dot.style.transform = "";
        });

        const duration = 3000;
        let startedAt = 0;

        function drawFrame(now) {
          if (!startedAt) {
            startedAt = now;
          }

          const elapsed = Math.min(now - startedAt, duration);
          const progress = elapsed / duration;
          const easedProgress = 1 - Math.pow(1 - progress, 3);
          line.style.strokeDashoffset = String(pathLength * (1 - easedProgress));

          if (progress < 1) {
            card.burnAnimationFrame = window.requestAnimationFrame(drawFrame);
          } else {
            line.style.strokeDashoffset = "0";
            card.burnAnimationFrame = null;
          }
        }

        window.requestAnimationFrame(() => {
          card.classList.add("is-burn-active");
          card.burnAnimationFrame = window.requestAnimationFrame(drawFrame);
        });
      };
    });
  }

  function playBurndownsForSlide(slide) {
    slide.querySelectorAll(".burndown-hero-card").forEach((card) => {
      if (typeof card.playBurndown === "function") {
        card.playBurndown();
      }
    });
  }

  function setupVelocityAnimations() {
    const panels = Array.from(document.querySelectorAll(".velocity-panel"));

    panels.forEach((panel) => {
      const fills = Array.from(panel.querySelectorAll(".velocity-fill"));

      panel.classList.add("js-velocity");

      fills.forEach((fill, index) => {
        fill.style.transitionDelay = `${Math.min(index * 110, 440)}ms`;
      });

      panel.playVelocity = function playVelocity() {
        if (prefersReducedMotion) {
          fills.forEach((fill) => {
            fill.style.transform = "scaleX(1)";
          });
          return;
        }

        panel.classList.remove("is-velocity-active");
        fills.forEach((fill) => {
          fill.style.transition = "none";
          fill.style.transform = "scaleX(0)";
        });

        // Force the reset to commit so returning to this slide replays the bars.
        panel.offsetHeight;

        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            fills.forEach((fill) => {
              fill.style.transition = "";
              fill.style.transform = "";
            });
            panel.classList.add("is-velocity-active");
          });
        });
      };
    });
  }

  function playVelocityForSlide(slide) {
    slide.querySelectorAll(".velocity-panel").forEach((panel) => {
      if (typeof panel.playVelocity === "function") {
        panel.playVelocity();
      }
    });
  }

  function nearestSlideIndex() {
    const viewportTop = window.scrollY;
    let nearest = 0;
    let distance = Infinity;

    slides.forEach((slide, index) => {
      const nextDistance = Math.abs(slide.offsetTop - viewportTop);

      if (nextDistance < distance) {
        nearest = index;
        distance = nextDistance;
      }
    });

    return nearest;
  }

  function updateProgress() {
    const index = nearestSlideIndex();
    const ratio = slides.length === 1 ? 1 : (index + 1) / slides.length;

    if (progress) {
      progress.style.width = `${Math.round(ratio * 100)}%`;
    }

    if (history.replaceState) {
      history.replaceState(null, "", `#${slides[index].id}`);
    }

    if (index !== activeSlideIndex) {
      activeSlideIndex = index;
      playBurndownsForSlide(slides[index]);
      playVelocityForSlide(slides[index]);
    }
  }

  function goTo(index) {
    const safeIndex = Math.max(0, Math.min(slides.length - 1, index));
    slides[safeIndex].scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function goNext() {
    goTo(nearestSlideIndex() + 1);
  }

  function goPrevious() {
    goTo(nearestSlideIndex() - 1);
  }

  document.addEventListener("keydown", (event) => {
    if (["ArrowDown", "PageDown", " "].includes(event.key)) {
      event.preventDefault();
      goNext();
    }

    if (["ArrowUp", "PageUp"].includes(event.key)) {
      event.preventDefault();
      goPrevious();
    }
  });

  if (nextButton) {
    nextButton.addEventListener("click", goNext);
  }

  if (prevButton) {
    prevButton.addEventListener("click", goPrevious);
  }

  setupBurndownAnimations();
  setupVelocityAnimations();
  window.addEventListener("scroll", updateProgress, { passive: true });
  window.addEventListener("resize", updateProgress);
  updateProgress();
})();
