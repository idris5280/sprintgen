(function () {
  const deck = document.querySelector(".deck");
  const slides = Array.from(document.querySelectorAll(".slide"));
  const progressText = document.querySelector(".progress-text");
  const progressFill = document.querySelector(".progress-fill");
  const previousButton = document.querySelector("[data-present-prev]");
  const nextButton = document.querySelector("[data-present-next]");

  if (!deck || slides.length === 0) {
    return;
  }

  let activeIndex = 0;
  let programmaticScroll = false;
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const vibe = document.body.classList.contains("vibe-dark")
    ? "dark"
    : document.body.classList.contains("vibe-light")
      ? "light"
      : "prismatic";

  function edgeBiasedPosition() {
    let left = Math.random() * 100;
    let top = Math.random() * 100;
    const isCentral = left > 18 && left < 82 && top > 20 && top < 80;

    if (isCentral && Math.random() > 0.28) {
      if (Math.random() > 0.5) {
        left = Math.random() > 0.5 ? 84 + Math.random() * 12 : 4 + Math.random() * 12;
      } else {
        top = Math.random() > 0.5 ? 82 + Math.random() * 12 : 8 + Math.random() * 10;
      }
    }

    return { left, top };
  }

  function createSparkles() {
    const field = document.createElement("div");
    const baseCount = vibe === "prismatic" ? 54 : vibe === "dark" ? 20 : 16;
    const sparkleCount = prefersReducedMotion ? Math.max(6, Math.round(baseCount * 0.24)) : baseCount;
    const colorClasses =
      vibe === "dark"
        ? ["is-silver"]
        : vibe === "prismatic"
          ? ["is-cyan", "is-magenta", "is-violet"]
          : ["is-cyan", "is-violet"];

    field.className = "sparkle-field";
    field.setAttribute("aria-hidden", "true");

    for (let index = 0; index < sparkleCount; index += 1) {
      const sparkle = document.createElement("span");
      const position = edgeBiasedPosition();
      const size = vibe === "prismatic" ? 2 + Math.random() * 3 : 1.5 + Math.random() * 2;
      const opacity = vibe === "prismatic" ? .28 + Math.random() * .42 : .16 + Math.random() * .22;
      const colorClass = colorClasses[index % colorClasses.length];

      sparkle.className = `sparkle ${colorClass}`;
      sparkle.style.setProperty("--sparkle-left", `${position.left.toFixed(2)}%`);
      sparkle.style.setProperty("--sparkle-top", `${position.top.toFixed(2)}%`);
      sparkle.style.setProperty("--sparkle-size", `${size.toFixed(2)}px`);
      sparkle.style.setProperty("--sparkle-opacity", opacity.toFixed(2));
      sparkle.style.setProperty("--sparkle-drift-x", `${(-8 + Math.random() * 16).toFixed(2)}px`);
      sparkle.style.setProperty("--sparkle-drift-y", `${(-12 + Math.random() * 10).toFixed(2)}px`);
      sparkle.style.animationDelay = `${(-1 * Math.random() * 7).toFixed(2)}s`;
      field.appendChild(sparkle);
    }

    document.body.appendChild(field);
  }

  function setActive(index, options = {}) {
    const nextIndex = Math.max(0, Math.min(slides.length - 1, index));
    activeIndex = nextIndex;

    slides.forEach((slide, slideIndex) => {
      slide.classList.toggle("is-active", slideIndex === nextIndex);
    });

    const slideNumber = nextIndex + 1;
    const progress = (slideNumber / slides.length) * 100;

    if (progressText) {
      progressText.textContent = `${slideNumber} / ${slides.length}`;
    }

    if (progressFill) {
      progressFill.style.width = `${progress}%`;
    }

    if (previousButton) {
      previousButton.disabled = nextIndex === 0;
    }

    if (nextButton) {
      nextButton.disabled = nextIndex === slides.length - 1;
    }

    if (options.updateHash !== false) {
      const id = slides[nextIndex].id;
      if (id) {
        history.replaceState(null, "", `#${id}`);
      }
    }
  }

  function goToSlide(index) {
    const nextIndex = Math.max(0, Math.min(slides.length - 1, index));
    programmaticScroll = true;
    slides[nextIndex].scrollIntoView({
      block: "start",
      behavior: prefersReducedMotion ? "auto" : "smooth"
    });
    setActive(nextIndex);
    window.setTimeout(() => {
      programmaticScroll = false;
    }, 520);
  }

  function updateFromScroll() {
    if (programmaticScroll) {
      return;
    }

    const viewportMidpoint = window.innerHeight / 2;
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;

    slides.forEach((slide, index) => {
      const rect = slide.getBoundingClientRect();
      const slideMidpoint = rect.top + rect.height / 2;
      const distance = Math.abs(slideMidpoint - viewportMidpoint);

      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    });

    if (closestIndex !== activeIndex) {
      setActive(closestIndex);
    }
  }

  function handleKeydown(event) {
    const nextKeys = ["ArrowDown", "PageDown", " "];
    const previousKeys = ["ArrowUp", "PageUp"];

    if (nextKeys.includes(event.key)) {
      event.preventDefault();
      goToSlide(activeIndex + 1);
    }

    if (previousKeys.includes(event.key)) {
      event.preventDefault();
      goToSlide(activeIndex - 1);
    }
  }

  previousButton && previousButton.addEventListener("click", () => goToSlide(activeIndex - 1));
  nextButton && nextButton.addEventListener("click", () => goToSlide(activeIndex + 1));
  deck.addEventListener("scroll", updateFromScroll, { passive: true });
  window.addEventListener("keydown", handleKeydown);
  createSparkles();

  const initialHash = window.location.hash.slice(1);
  const initialIndex = slides.findIndex((slide) => slide.id === initialHash);

  if (initialIndex >= 0) {
    setActive(initialIndex, { updateHash: false });
    window.setTimeout(() => goToSlide(initialIndex), 0);
  } else {
    setActive(0, { updateHash: false });
  }
})();
