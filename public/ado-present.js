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
      const marker = card.querySelector(".burn-outcome-marker");

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
          if (marker) {
            marker.style.opacity = 1;
          }
          return;
        }

        card.classList.remove("is-burn-active");
        line.style.strokeDashoffset = pathLength;

        dots.forEach((dot) => {
          dot.style.opacity = "";
          dot.style.transform = "";
        });
        if (marker) {
          marker.style.opacity = "";
        }

        // Force animation reset so dots and the final outcome marker replay when revisiting the slide.
        card.offsetHeight;

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

  function formatMetricValue(element, value) {
    const prefix = element.getAttribute("data-count-prefix") || "";
    const suffix = element.getAttribute("data-count-suffix") || "";
    const decimals = Number(element.getAttribute("data-count-decimals") || 0);
    const safeDecimals = Number.isFinite(decimals) ? Math.max(0, Math.min(2, decimals)) : 0;
    const formatted = Number(value).toLocaleString("en-US", {
      minimumFractionDigits: safeDecimals,
      maximumFractionDigits: safeDecimals
    });

    return `${prefix}${formatted}${suffix}`;
  }

  function setMetricFinalValue(element) {
    const target = Number(element.getAttribute("data-count-target") || 0);
    element.textContent = formatMetricValue(element, Number.isFinite(target) ? target : 0);
  }

  function animateMetricValue(element, delay) {
    const target = Number(element.getAttribute("data-count-target") || 0);

    if (element.metricAnimationFrame) {
      window.cancelAnimationFrame(element.metricAnimationFrame);
    }

    if (element.metricAnimationDelay) {
      window.clearTimeout(element.metricAnimationDelay);
    }

    if (!Number.isFinite(target) || prefersReducedMotion) {
      setMetricFinalValue(element);
      return;
    }

    element.textContent = formatMetricValue(element, 0);

    element.metricAnimationDelay = window.setTimeout(() => {
      const duration = 1150;
      let startedAt = 0;

      function frame(now) {
        if (!startedAt) {
          startedAt = now;
        }

        const progress = Math.min((now - startedAt) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        element.textContent = formatMetricValue(element, target * eased);

        if (progress < 1) {
          element.metricAnimationFrame = window.requestAnimationFrame(frame);
        } else {
          setMetricFinalValue(element);
          element.metricAnimationFrame = null;
        }
      }

      element.metricAnimationFrame = window.requestAnimationFrame(frame);
    }, delay);
  }

  function setupMetricCountAnimations() {
    const grids = Array.from(document.querySelectorAll(".metric-card-grid"));

    grids.forEach((grid) => {
      const values = Array.from(grid.querySelectorAll("[data-count-target]"));

      if (values.length === 0) {
        return;
      }

      grid.playMetricCounts = function playMetricCounts() {
        values.forEach((value, index) => {
          animateMetricValue(value, Math.min(index * 120, 360));
        });
      };
    });
  }

  function playMetricCountsForSlide(slide) {
    slide.querySelectorAll(".metric-card-grid").forEach((grid) => {
      if (typeof grid.playMetricCounts === "function") {
        grid.playMetricCounts();
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

    slides.forEach((slide, slideIndex) => {
      slide.classList.toggle("is-active", slideIndex === index);
    });

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
      playMetricCountsForSlide(slides[index]);
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
  setupMetricCountAnimations();
  window.addEventListener("scroll", updateProgress, { passive: true });
  window.addEventListener("resize", updateProgress);
  updateProgress();
})();
