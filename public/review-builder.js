(function () {
  var DRAFT_DB_NAME = "scrum-studio-review-drafts";
  var DRAFT_DB_VERSION = 1;
  var DRAFT_STORE_NAME = "drafts";
  var DRAFT_SAVE_DELAY_MS = 700;
  var HEALTH_CHECK_MS = 5000;
  var CLIENT_IMAGE_TARGET_BYTES = 2.5 * 1024 * 1024;
  var CLIENT_IMAGE_HARD_LIMIT_BYTES = 10.5 * 1024 * 1024;
  var CLIENT_IMAGE_MAX_EDGE = 1800;
  var dbPromise = null;

  function toArray(value) {
    return Array.prototype.slice.call(value || []);
  }

  function makeSectionId(type) {
    return type + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function formatTime(date) {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 1024) return "0 KB";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "") + " MB";
  }

  function openDraftDb() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve) {
      var request = indexedDB.open(DRAFT_DB_NAME, DRAFT_DB_VERSION);

      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(DRAFT_STORE_NAME)) {
          db.createObjectStore(DRAFT_STORE_NAME, { keyPath: "key" });
        }
      };

      request.onsuccess = function () {
        resolve(request.result);
      };

      request.onerror = function () {
        resolve(null);
      };
    });

    return dbPromise;
  }

  function draftTransaction(mode, callback) {
    return openDraftDb().then(function (db) {
      if (!db) return null;

      return new Promise(function (resolve) {
        var transaction = db.transaction(DRAFT_STORE_NAME, mode);
        var store = transaction.objectStore(DRAFT_STORE_NAME);
        var request = callback(store);

        request.onsuccess = function () {
          resolve(request.result || null);
        };

        request.onerror = function () {
          resolve(null);
        };
      });
    });
  }

  function getDraft(key) {
    return draftTransaction("readonly", function (store) {
      return store.get(key);
    });
  }

  function putDraft(draft) {
    return draftTransaction("readwrite", function (store) {
      return store.put(draft);
    });
  }

  function deleteDraft(key) {
    return draftTransaction("readwrite", function (store) {
      return store.delete(key);
    });
  }

  function getFieldValue(form, name) {
    var field = toArray(form.elements).find(function (element) {
      return element.name === name;
    });
    return field ? String(field.value || "") : "";
  }

  function getDraftKey(form) {
    var areaPaths = toArray(form.querySelectorAll("input[name='areaPaths']"))
      .map(function (input) { return input.value; })
      .filter(Boolean)
      .join("|");
    var parts = [
      "scrum-studio-review-builder-v2",
      form.getAttribute("action") || location.pathname,
      getFieldValue(form, "team"),
      getFieldValue(form, "sprint"),
      areaPaths || getFieldValue(form, "areaPath")
    ];

    return parts.join("::");
  }

  function serializeSections(form) {
    return toArray(form.querySelectorAll("[data-review-section]")).map(function (section, index) {
      var idInput = section.querySelector("input[name='sectionIds']");
      var typeInput = idInput
        ? section.querySelector("[name='section_type_" + idInput.value + "']")
        : null;

      return {
        id: idInput ? idInput.value : "section-" + (index + 1),
        type: typeInput ? typeInput.value : "delivery"
      };
    });
  }

  function serializeFields(form) {
    return toArray(form.elements)
      .filter(function (element) {
        return element.name && element.type !== "file" && element.type !== "button" && element.type !== "submit";
      })
      .map(function (element) {
        if (element.tagName === "SELECT" && element.multiple) {
          return {
            name: element.name,
            tag: element.tagName,
            type: element.type,
            values: toArray(element.selectedOptions).map(function (option) { return option.value; })
          };
        }

        if (element.type === "checkbox" || element.type === "radio") {
          return {
            name: element.name,
            tag: element.tagName,
            type: element.type,
            value: element.value,
            checked: element.checked
          };
        }

        return {
          name: element.name,
          tag: element.tagName,
          type: element.type,
          value: element.value
        };
      });
  }

  function serializeImages(form) {
    return toArray(form.querySelectorAll("[data-screenshot-input]"))
      .map(function (input) {
        var file = input.files && input.files[0];

        if (!file) return null;

        return {
          fieldName: input.name,
          name: file.name || "screenshot.jpg",
          type: file.type || "image/jpeg",
          lastModified: file.lastModified || Date.now(),
          blob: file
        };
      })
      .filter(Boolean);
  }

  function snapshotForm(form) {
    return {
      fields: serializeFields(form),
      images: serializeImages(form),
      sections: serializeSections(form),
      signature: JSON.stringify({
        fields: serializeFields(form),
        sections: serializeSections(form)
      })
    };
  }

  function controlsByName(form, name) {
    return toArray(form.elements).filter(function (element) {
      return element.name === name;
    });
  }

  function restoreFields(form, draft) {
    (draft.fields || []).forEach(function (field) {
      var controls = controlsByName(form, field.name);

      if (controls.length === 0) return;

      if (field.type === "checkbox" || field.type === "radio") {
        controls.forEach(function (control) {
          if (control.value === field.value) {
            control.checked = Boolean(field.checked);
          }
        });
        return;
      }

      controls.forEach(function (control) {
        if (control.tagName === "SELECT" && control.multiple) {
          var selected = new Set(field.values || []);
          toArray(control.options).forEach(function (option) {
            option.selected = selected.has(option.value);
          });
          return;
        }

        control.value = field.value || "";
      });
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

  function assignFile(input, file, dispatchChange) {
    if (!input || !file) return false;

    try {
      var dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      input.files = dataTransfer.files;

      if (dispatchChange !== false) {
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  function restoreImages(form, draft) {
    return Promise.all((draft.images || []).map(function (image) {
      var input = toArray(form.querySelectorAll("[data-screenshot-input]")).find(function (candidate) {
        return candidate.name === image.fieldName;
      });

      if (!input || !image.blob) return Promise.resolve();

      var file = new File([image.blob], image.name || "screenshot.jpg", {
        type: image.type || image.blob.type || "image/jpeg",
        lastModified: image.lastModified || Date.now()
      });
      var zone = input.closest("[data-screenshot-drop]");
      var preview = zone && zone.querySelector("[data-screenshot-preview]");
      var clearButton = zone && zone.querySelector("[data-screenshot-clear]");
      var removeInput = zone && zone.querySelector("[data-screenshot-remove]");

      assignFile(input, file, false);
      if (removeInput) removeInput.value = "";
      if (clearButton) clearButton.hidden = false;
      setPreview(preview, file);
      return Promise.resolve();
    }));
  }

  function restoreSections(form, draft) {
    var list = form.querySelector("[data-section-list]");
    if (!list || !draft.sections || draft.sections.length === 0) return;

    list.innerHTML = "";
    draft.sections.forEach(function (section) {
      var type = section.type || "delivery";
      var id = section.id || makeSectionId(type);
      var template = form.querySelector("[data-section-template='" + type + "']");

      if (!template) return;

      list.insertAdjacentHTML("beforeend", template.innerHTML.replace(/__SECTION_ID__/g, id));
    });

    initStoryPickers(list);
    initScreenshotInputs(list);
    updateSectionNumbers(form);
  }

  function restoreDraft(form, draft) {
    restoreSections(form, draft);
    restoreFields(form, draft);
    initStoryPickers(form);
    initScreenshotInputs(form);
    updateSectionNumbers(form);
    return restoreImages(form, draft);
  }

  function updateDraftStatus(form, message, tone) {
    var status = form.querySelector("[data-draft-status]");
    if (!status) return;

    status.textContent = message;
    status.dataset.tone = tone || "neutral";
  }

  function setDraftPanelMode(form, mode) {
    var panel = form.querySelector("[data-draft-guard]");
    if (!panel) return;

    panel.hidden = false;
    panel.dataset.mode = mode || "saved";
  }

  function setDraftActionVisibility(form, visible) {
    var actions = form.querySelector("[data-draft-actions]");
    var restoreButton = form.querySelector("[data-restore-draft]");
    var discardButton = form.querySelector("[data-discard-draft]");
    var shouldShow = Boolean(visible);

    if (actions) actions.hidden = !shouldShow;
    if (restoreButton) restoreButton.hidden = !shouldShow;
    if (discardButton) discardButton.hidden = !shouldShow;
  }

  function scheduleDraftSave(form) {
    clearTimeout(form._draftSaveTimer);
    form._draftSaveTimer = setTimeout(function () {
      saveDraft(form);
    }, DRAFT_SAVE_DELAY_MS);
  }

  function saveDraft(form) {
    if (!form || !form.dataset.draftKey) return Promise.resolve();

    var snapshot = snapshotForm(form);
    var draft = {
      key: form.dataset.draftKey,
      updatedAt: Date.now(),
      path: location.pathname,
      title: document.title,
      fields: snapshot.fields,
      images: snapshot.images,
      sections: snapshot.sections,
      signature: snapshot.signature
    };

    return putDraft(draft).then(function () {
      updateDraftStatus(form, "Saved " + formatTime(new Date()), "saved");
    });
  }

  function hasDifferentDraft(form, draft) {
    if (!draft) return false;
    return draft.signature !== snapshotForm(form).signature || (draft.images || []).length > 0;
  }

  function initDraftGuard(form) {
    if (!form || form.dataset.draftGuardReady === "true") return;

    form.dataset.draftGuardReady = "true";
    form.dataset.draftKey = getDraftKey(form);
    form.insertAdjacentHTML(
      "afterbegin",
      '<div class="draft-guard" data-draft-guard data-mode="saved" hidden>' +
        '<div><strong data-draft-title>Draft protected</strong><small data-draft-status>Draft ready</small></div>' +
        '<div class="draft-guard-actions" data-draft-actions hidden>' +
          '<button class="secondary-button" type="button" data-restore-draft hidden>Restore Draft</button>' +
          '<button class="ghost-button" type="button" data-discard-draft hidden>Discard Draft</button>' +
        '</div>' +
      '</div>'
    );

    var restoreButton = form.querySelector("[data-restore-draft]");
    var discardButton = form.querySelector("[data-discard-draft]");

    getDraft(form.dataset.draftKey).then(function (draft) {
      setDraftPanelMode(form, "saved");
      setDraftActionVisibility(form, false);

      if (draft && hasDifferentDraft(form, draft)) {
        form._pendingDraft = draft;
        setDraftPanelMode(form, "restore");
        setDraftActionVisibility(form, true);
        var restoreTitle = form.querySelector("[data-draft-title]");
        if (restoreTitle) restoreTitle.textContent = "Draft available";
        updateDraftStatus(form, "Unsaved draft found from " + formatTime(new Date(draft.updatedAt)) + ".", "warning");
      } else {
        updateDraftStatus(form, "Draft protection is on", "saved");
        saveDraft(form);
      }
    });

    restoreButton.addEventListener("click", function () {
      if (!form._pendingDraft) return;

      restoreDraft(form, form._pendingDraft).then(function () {
        form._pendingDraft = null;
        setDraftPanelMode(form, "saved");
        setDraftActionVisibility(form, false);
        var title = form.querySelector("[data-draft-title]");
        if (title) title.textContent = "Draft protected";
        updateDraftStatus(form, "Draft restored " + formatTime(new Date()), "saved");
        scheduleDraftSave(form);
      });
    });

    discardButton.addEventListener("click", function () {
      clearTimeout(form._draftSaveTimer);
      deleteDraft(form.dataset.draftKey).then(function () {
        form._pendingDraft = null;
        setDraftPanelMode(form, "saved");
        setDraftActionVisibility(form, false);
        var title = form.querySelector("[data-draft-title]");
        if (title) title.textContent = "Draft protected";
        updateDraftStatus(form, "Draft protection is on", "saved");
      });
    });

    form.addEventListener("input", function () {
      scheduleDraftSave(form);
    });

    form.addEventListener("change", function () {
      scheduleDraftSave(form);
    });

    form.addEventListener("click", function (event) {
      if (event.target.closest("[data-section-move], [data-section-remove], [data-add-section], [data-screenshot-clear]")) {
        setTimeout(function () { scheduleDraftSave(form); }, 0);
      }
    });
  }

  function setServerOnline(form, online) {
    form.dataset.serverOnline = online ? "true" : "false";
    var submit = form.querySelector(".builder-submit-panel button[type='submit'], button[type='submit']");
    var title = form.querySelector("[data-draft-title]");

    if (submit) {
      submit.disabled = !online || form.dataset.submitting === "true";
    }

    if (!online) {
      setDraftPanelMode(form, "offline");
      if (!form._pendingDraft) setDraftActionVisibility(form, false);
      if (title) title.textContent = "Scrum Studio is not running";
      updateDraftStatus(form, "Your draft is saved here. Restart Scrum Studio, then generate again.", "warning");
      return;
    }

    if (title) title.textContent = "Draft protected";
    if (!form._pendingDraft) {
      setDraftPanelMode(form, "saved");
      setDraftActionVisibility(form, false);
    }
  }

  function verifyServerOnline() {
    return fetch("/api/health?ts=" + Date.now(), { cache: "no-store" })
      .then(function (response) {
        return response.ok;
      })
      .catch(function () {
        return false;
      });
  }

  function checkServerHealth(form) {
    verifyServerOnline().then(function (online) {
      setServerOnline(form, online);
    });
  }

  function initHealthGuard(form) {
    if (!form || form.dataset.healthGuardReady === "true") return;

    form.dataset.healthGuardReady = "true";
    form.dataset.serverOnline = "true";
    checkServerHealth(form);
    setInterval(function () {
      checkServerHealth(form);
    }, HEALTH_CHECK_MS);
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      var url = URL.createObjectURL(file);

      image.onload = function () {
        URL.revokeObjectURL(url);
        resolve(image);
      };

      image.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read screenshot."));
      };

      image.src = url;
    });
  }

  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        resolve(blob);
      }, "image/jpeg", quality);
    });
  }

  function drawImageToCanvas(image, maxEdge) {
    var scale = Math.min(1, maxEdge / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
    var width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
    var height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
    var canvas = document.createElement("canvas");
    var context = canvas.getContext("2d");

    canvas.width = width;
    canvas.height = height;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    return canvas;
  }

  function compressImageFile(file) {
    if (!file || !/^image\//i.test(file.type || "")) return Promise.resolve(file);

    if (file.size <= CLIENT_IMAGE_TARGET_BYTES) {
      return Promise.resolve(file);
    }

    return loadImage(file)
      .then(function (image) {
        var edges = [CLIENT_IMAGE_MAX_EDGE, 1500, 1200, 1000];
        var qualities = [0.86, 0.76, 0.66, 0.56];
        var bestBlob = null;
        var chain = Promise.resolve();

        edges.forEach(function (edge) {
          qualities.forEach(function (quality) {
            chain = chain.then(function () {
              if (bestBlob && bestBlob.size <= CLIENT_IMAGE_TARGET_BYTES) return null;

              return canvasToBlob(drawImageToCanvas(image, edge), quality).then(function (blob) {
                if (blob && (!bestBlob || blob.size < bestBlob.size)) {
                  bestBlob = blob;
                }
              });
            });
          });
        });

        return chain.then(function () {
          if (!bestBlob) return file;

          var name = String(file.name || "screenshot").replace(/\.[^.]+$/, "") + ".jpg";
          return new File([bestBlob], name, {
            type: "image/jpeg",
            lastModified: Date.now()
          });
        });
      })
      .catch(function () {
        return file;
      });
  }

  function updateScreenshotNote(zone, message, tone) {
    if (!zone) return;

    var note = zone.querySelector("[data-screenshot-note]");
    if (!note) {
      note = document.createElement("small");
      note.setAttribute("data-screenshot-note", "");
      note.className = "screenshot-note";
      zone.appendChild(note);
    }

    note.textContent = message || "";
    note.dataset.tone = tone || "neutral";
    note.hidden = !message;
  }

  function handleScreenshotFile(input, file, form) {
    if (!input || !file) return Promise.resolve(false);

    var zone = input.closest("[data-screenshot-drop]");
    var preview = zone && zone.querySelector("[data-screenshot-preview]");
    var clearButton = zone && zone.querySelector("[data-screenshot-clear]");
    var removeInput = zone && zone.querySelector("[data-screenshot-remove]");

    if (zone) zone.classList.add("is-processing");
    updateScreenshotNote(zone, "Optimizing screenshot...", "neutral");

    return compressImageFile(file).then(function (processed) {
      if (processed.size > CLIENT_IMAGE_HARD_LIMIT_BYTES) {
        updateScreenshotNote(zone, "This screenshot is still too large after optimization. Choose a smaller image.", "warning");
        return false;
      }

      assignFile(input, processed, false);
      if (removeInput) removeInput.value = "";
      if (clearButton) clearButton.hidden = false;
      setPreview(preview, processed);

      if (processed.size < file.size) {
        updateScreenshotNote(zone, "Optimized from " + formatBytes(file.size) + " to " + formatBytes(processed.size) + ".", "saved");
      } else {
        updateScreenshotNote(zone, "Screenshot ready (" + formatBytes(processed.size) + ").", "saved");
      }

      if (form) scheduleDraftSave(form);
      return true;
    }).finally(function () {
      if (zone) zone.classList.remove("is-processing");
    });
  }

  function compressAllScreenshots(form) {
    var inputs = toArray(form.querySelectorAll("[data-screenshot-input]"));
    var chain = Promise.resolve(true);

    inputs.forEach(function (input) {
      chain = chain.then(function (ok) {
        if (!ok) return false;

        var file = input.files && input.files[0];
        if (!file) return true;
        return handleScreenshotFile(input, file, form);
      });
    });

    return chain;
  }

  function firstImageFromTransfer(dataTransfer) {
    var files = toArray(dataTransfer && dataTransfer.files);
    return files.find(function (file) {
      return /^image\//i.test(file.type || "");
    });
  }

  function updateStoryPickerTotal(picker) {
    var total = picker.querySelector("[data-picker-total]");
    var inputs = toArray(picker.querySelectorAll("input[type='checkbox']"));
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

  function initStoryPickers(root) {
    toArray((root || document).querySelectorAll("[data-story-picker]")).forEach(function (picker) {
      if (picker.dataset.storyPickerReady === "true") {
        updateStoryPickerTotal(picker);
        return;
      }

      picker.dataset.storyPickerReady = "true";

      picker.addEventListener("change", function () {
        updateStoryPickerTotal(picker);
      });
      updateStoryPickerTotal(picker);
    });
  }

  function updateSectionNumbers(form) {
    toArray(form.querySelectorAll("[data-review-section]")).forEach(function (section, index) {
      var number = section.querySelector("[data-section-number]");
      if (number) number.textContent = String(index + 1);
    });
  }

  function initScreenshotInputs(root) {
    toArray((root || document).querySelectorAll("[data-screenshot-drop]")).forEach(function (zone) {
      if (zone.dataset.screenshotReady === "true") return;

      zone.dataset.screenshotReady = "true";
      var input = zone.querySelector("[data-screenshot-input]");
      var clearButton = zone.querySelector("[data-screenshot-clear]");
      var removeInput = zone.querySelector("[data-screenshot-remove]");
      var form = zone.closest("[data-review-builder-form]");

      if (input) {
        input.addEventListener("change", function () {
          var file = input.files && input.files[0];
          if (file) handleScreenshotFile(input, file, form);
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
        if (file) handleScreenshotFile(input, file, form);
      });

      zone.addEventListener("paste", function (event) {
        var file = firstImageFromTransfer(event.clipboardData);
        if (file) handleScreenshotFile(input, file, form);
      });

      if (clearButton) {
        clearButton.addEventListener("click", function () {
          if (input) input.value = "";
          if (removeInput) removeInput.value = "yes";
          var preview = zone.querySelector("[data-screenshot-preview]");
          if (preview) {
            preview.classList.remove("has-image");
            preview.innerHTML = "<span>Paste, drop, or choose a screenshot</span>";
          }
          updateScreenshotNote(zone, "", "neutral");
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
        var sectionToMove = moveButton.closest("[data-review-section]");
        if (!sectionToMove || !list) return;

        if (moveButton.getAttribute("data-section-move") === "up" && sectionToMove.previousElementSibling) {
          list.insertBefore(sectionToMove, sectionToMove.previousElementSibling);
        }

        if (moveButton.getAttribute("data-section-move") === "down" && sectionToMove.nextElementSibling) {
          list.insertBefore(sectionToMove.nextElementSibling, sectionToMove);
        }

        updateSectionNumbers(form);
      }
    });

    updateSectionNumbers(form);
  }

  function initSubmitGuard(form) {
    if (!form || form.dataset.submitGuardReady === "true") return;

    form.dataset.submitGuardReady = "true";
    form.addEventListener("submit", function (event) {
      if (form.dataset.submitReady === "true") return;

      event.preventDefault();

      form.dataset.submitting = "true";
      var submit = form.querySelector(".builder-submit-panel button[type='submit'], button[type='submit']");
      if (submit) {
        submit.disabled = true;
        submit.textContent = "Preparing...";
      }
      updateDraftStatus(form, "Checking Scrum Studio and saving draft...", "neutral");

      verifyServerOnline().then(function (online) {
        if (!online) {
          form.dataset.submitting = "false";
          setServerOnline(form, false);
          saveDraft(form);
          return Promise.resolve(null);
        }

        updateDraftStatus(form, "Saving draft and optimizing screenshots...", "neutral");
        return compressAllScreenshots(form);
      }).then(function (ok) {
        if (ok === null) return;

        if (!ok) {
          form.dataset.submitting = "false";
          if (submit) {
            submit.disabled = false;
            submit.textContent = submit.getAttribute("data-original-label") || submit.textContent || "Generate Report";
          }
          updateDraftStatus(form, "One screenshot is too large. Your draft is saved.", "warning");
          saveDraft(form);
          return;
        }

        saveDraft(form).then(function () {
          form.dataset.submitReady = "true";
          form.submit();
        });
      });
    });

    var submit = form.querySelector(".builder-submit-panel button[type='submit'], button[type='submit']");
    if (submit) submit.setAttribute("data-original-label", submit.textContent || "Generate Report");
  }

  function init(root) {
    var scope = root || document;
    initStoryPickers(scope);
    initScreenshotInputs(scope);
    toArray(scope.querySelectorAll("[data-review-builder-form]")).forEach(function (form) {
      initSections(form);
      initDraftGuard(form);
      initHealthGuard(form);
      initSubmitGuard(form);
    });
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
