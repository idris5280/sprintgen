(function () {
  function toArray(value) {
    return Array.prototype.slice.call(value || []);
  }

  function makeSectionId(type) {
    return type + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function initStoryPickers(root) {
    toArray((root || document).querySelectorAll("[data-story-picker]")).forEach(function (picker) {
      if (picker.dataset.storyPickerReady === "true") return;

      picker.dataset.storyPickerReady = "true";
      var total = picker.querySelector("[data-picker-total]");
      var inputs = toArray(picker.querySelectorAll("input[type='checkbox']"));

      function updateTotal() {
        var selected = inputs.filter(function (input) {
          return input.checked;
        });
        var points = selected.reduce(function (sum, input) {
          var value = Number(input.getAttribute("data-points") || 0);
          return sum + (Number.isFinite(value) ? value : 0);
        }, 0);

        if (total) {
          total.textContent = selected.length + " selected / " + points.toLocaleString("en-US", { maximumFractionDigits: 1 }) + " pts";
        }
      }

      picker.addEventListener("change", updateTotal);
      updateTotal();
    });
  }

  function updateSectionNumbers(form) {
    toArray(form.querySelectorAll("[data-review-section]")).forEach(function (section, index) {
      var number = section.querySelector("[data-section-number]");
      if (number) number.textContent = String(index + 1);
    });
  }

  function setPreview(preview, file) {
    if (!preview || !file) return;

    var reader = new FileReader();
    reader.addEventListener("load", function () {
      preview.classList.add("has-image");
      preview.innerHTML = "";
      var image = document.createElement("img");
      image.src = String(reader.result || "");
      image.alt = "Uploaded screenshot preview";
      preview.appendChild(image);
    });
    reader.readAsDataURL(file);
  }

  function assignFile(input, file) {
    if (!input || !file) return false;

    try {
      var dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (error) {
      return false;
    }
  }

  function firstImageFromTransfer(dataTransfer) {
    var files = toArray(dataTransfer && dataTransfer.files);
    return files.find(function (file) {
      return /^image\//i.test(file.type || "");
    });
  }

  function initScreenshotInputs(root) {
    toArray((root || document).querySelectorAll("[data-screenshot-drop]")).forEach(function (zone) {
      if (zone.dataset.screenshotReady === "true") return;

      zone.dataset.screenshotReady = "true";
      var input = zone.querySelector("[data-screenshot-input]");
      var preview = zone.querySelector("[data-screenshot-preview]");
      var clearButton = zone.querySelector("[data-screenshot-clear]");
      var removeInput = zone.querySelector("[data-screenshot-remove]");

      if (input) {
        input.addEventListener("change", function () {
          var file = input.files && input.files[0];
          if (file) {
            if (removeInput) removeInput.value = "";
            if (clearButton) clearButton.hidden = false;
            setPreview(preview, file);
          }
        });
      }

      zone.addEventListener("dragover", function (event) {
        event.preventDefault();
        zone.classList.add("is-dragging");
      });

      zone.addEventListener("dragleave", function () {
        zone.classList.remove("is-dragging");
      });

      zone.addEventListener("drop", function (event) {
        event.preventDefault();
        zone.classList.remove("is-dragging");
        var file = firstImageFromTransfer(event.dataTransfer);
        if (file) assignFile(input, file);
      });

      zone.addEventListener("paste", function (event) {
        var file = firstImageFromTransfer(event.clipboardData);
        if (file) assignFile(input, file);
      });

      if (clearButton) {
        clearButton.addEventListener("click", function () {
          if (input) input.value = "";
          if (removeInput) removeInput.value = "yes";
          if (preview) {
            preview.classList.remove("has-image");
            preview.innerHTML = "<span>Paste, drop, or choose a screenshot</span>";
          }
          clearButton.hidden = true;
        });
      }
    });
  }

  function initSections(form) {
    if (!form || form.dataset.sectionBuilderReady === "true") return;

    form.dataset.sectionBuilderReady = "true";
    var list = form.querySelector("[data-section-list]");

    form.addEventListener("click", function (event) {
      var addButton = event.target.closest("[data-add-section]");
      if (addButton) {
        var type = addButton.getAttribute("data-add-section");
        var template = form.querySelector("[data-section-template='" + type + "']");
        if (!template || !list) return;

        var id = makeSectionId(type);
        var html = template.innerHTML.replace(/__SECTION_ID__/g, id);
        list.insertAdjacentHTML("beforeend", html);
        var section = list.lastElementChild;
        initStoryPickers(section);
        initScreenshotInputs(section);
        updateSectionNumbers(form);
        var title = section && section.querySelector("input[type='text'], textarea, select");
        if (title) title.focus();
        return;
      }

      var removeButton = event.target.closest("[data-section-remove]");
      if (removeButton) {
        var removable = removeButton.closest("[data-review-section]");
        if (removable) removable.remove();
        updateSectionNumbers(form);
        return;
      }

      var moveButton = event.target.closest("[data-section-move]");
      if (moveButton) {
        var section = moveButton.closest("[data-review-section]");
        if (!section || !list) return;

        if (moveButton.getAttribute("data-section-move") === "up" && section.previousElementSibling) {
          list.insertBefore(section, section.previousElementSibling);
        }

        if (moveButton.getAttribute("data-section-move") === "down" && section.nextElementSibling) {
          list.insertBefore(section.nextElementSibling, section);
        }

        updateSectionNumbers(form);
      }
    });

    updateSectionNumbers(form);
  }

  function init(root) {
    var scope = root || document;
    initStoryPickers(scope);
    initScreenshotInputs(scope);
    toArray(scope.querySelectorAll("[data-review-builder-form]")).forEach(initSections);
  }

  window.ScrumStudioReviewBuilder = {
    init: init
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      init(document);
    });
  } else {
    init(document);
  }
})();
