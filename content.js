// ============================================================
//  Smart Job Form Autofill — Content Script
// ============================================================

// Guard: prevent duplicate initialization if popup injects us into
// a tab that already has the script running from the manifest injection.
if (window.__smartAutofillLoaded) {
  // Script already loaded — do nothing. The existing message listener
  // handles DO_AUTOFILL and resets state on every click.
} else {
window.__smartAutofillLoaded = true;

// ====== STATE ======
let autofillEnabled  = false;
let autofillData     = null;
let fuse             = null;
let searchItems      = [];
let matchThreshold   = 0.40;  // overridden at runtime from user setting
let processedElements = new WeakSet();
let processedRadios   = new Set();
let filledCount       = 0;

// ====== UTILITIES ======

function camelToText(str) {
  if (!str) return '';
  return str.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase().trim();
}

function base64ToBlob(base64, type = 'application/octet-stream') {
  const bin = window.atob(base64.split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// ====== FIELD CONTEXT EXTRACTION ======

function getFieldContext(el) {
  const parts = [];

  // ── 1. Element's own attributes ──────────────────────────────────────────
  if (el.placeholder)                   parts.push(el.placeholder);
  if (el.name)                          parts.push(camelToText(el.name));
  if (el.id)                            parts.push(camelToText(el.id));
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel)                        parts.push(ariaLabel);
  const ariaLB = el.getAttribute('aria-labelledby');
  if (ariaLB) {
    const lbEl = document.getElementById(ariaLB);
    if (lbEl) parts.push(lbEl.innerText);
  }
  // Workday: data-automation-id on the input itself
  const autoId = el.getAttribute('data-automation-id');
  if (autoId) parts.push(camelToText(autoId));

  // ── 2. Standard <label> association ──────────────────────────────────────
  let labelText = '';
  if (el.id) {
    const lbl = document.querySelector(`label[for="${el.id}"]`);
    if (lbl) labelText = lbl.innerText.trim();
  }
  if (!labelText) {
    const parentLbl = el.closest('label');
    if (parentLbl) labelText = parentLbl.innerText.trim();
  }

  // ── 3. Google Forms (2024 / 2025 DOM) ────────────────────────────────────
  if (!labelText) {
    const gfWrap = el.closest(
      '.freebirdFormviewerViewItemsItemItem,' +
      '.freebirdFormviewerComponentsQuestionBaseRoot,' +
      '[data-item-id],' +
      '.Qr7Oae'
    );
    if (gfWrap) {
      const titleEl = gfWrap.querySelector(
        '.freebirdFormviewerViewItemsItemItemTitle,' +
        '.freebirdFormviewerComponentsQuestionBaseTitle,' +
        '[role="heading"]'
      );
      if (titleEl) labelText = titleEl.innerText.trim();
      else labelText = gfWrap.innerText.split('\n')[0].trim().substring(0, 120);
    }
  }

  // ── 4. LinkedIn Easy Apply ────────────────────────────────────────────────
  if (!labelText) {
    const liWrap = el.closest(
      '.fb-dash-form-element,' +
      '.jobs-easy-apply-form-section__grouping,' +
      '.artdeco-text-input--container,' +
      '.jobs-easy-apply-form-element'
    );
    if (liWrap) {
      const liLbl = liWrap.querySelector(
        'label,' +
        '.artdeco-text-input--label,' +
        '.fb-dash-form-element__label,' +
        '.jobs-easy-apply-form-section__label'
      );
      if (liLbl) labelText = liLbl.innerText.trim();
    }
  }

  // ── 5. Workday ────────────────────────────────────────────────────────────
  if (!labelText) {
    const wdWrap = el.closest('[data-automation-id]');
    if (wdWrap && wdWrap !== el) {
      const wdId = wdWrap.getAttribute('data-automation-id');
      parts.push(camelToText(wdId));
      const wdLbl = wdWrap.querySelector('label, [data-automation-id$="Label"], [data-automation-id$="label"]');
      if (wdLbl) labelText = wdLbl.innerText.trim();
    }
  }

  // ── 6. Proximity fallback (generic SPAs / custom forms) ──────────────────
  if (!labelText) {
    let cur = el.parentElement;
    for (let d = 0; d < 4 && cur; d++, cur = cur.parentElement) {
      const t = (cur.innerText || '').trim();
      if (t.length > 2 && t.length < 140) { labelText = t; break; }
    }
  }

  if (labelText) parts.push(labelText);

  return parts
    .join(' ')
    .replace(/\n/g, ' ')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ====== FUSE INITIALIZATION ======

function initFuse(profileData) {
  autofillData = { ...profileData };

  // ── Auto-derive firstName / lastName from applicantName ──────────────────
  if (autofillData.applicantName && !autofillData.firstName) {
    const nameParts = autofillData.applicantName.trim().split(/\s+/);
    autofillData.firstName = nameParts[0] || '';
    autofillData.lastName  = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
  }

  // ── Alias dictionary ─────────────────────────────────────────────────────
  // IMPORTANT: These are the ONLY terms used for matching.
  // Do NOT include words shared between keys (e.g. "name" must not appear
  // in mothersName, fathersName — only in firstName/lastName/applicantName).
  // "current" must not appear in currentSalary — only in jobTitle/designation.
  const ALIASES = {
    // ─ Identity ─────────────────────────────────────────────────────────────
    firstName:           'first firstname given forename',
    lastName:            'last lastname surname family sur',
    applicantName:       'name fullname full applicant legal complete',
    fathersName:         'father dad paternal guardian',
    mothersName:         'mother mom maternal',
    dob:                 'dob date birth birthday born',
    gender:              'gender sex',
    bloodGroup:          'blood group rhesus',
    maritalStatus:       'marital married single spouse',
    religion:            'religion faith belief',
    caste:               'caste category obc general sc st',
    nationality:         'nationality citizenship citizen',
    // ─ Contact ──────────────────────────────────────────────────────────────
    email:               'email mail',
    phone:               'mobile phone cell telephone contact',
    altPhone:            'alternative secondary emergency backup mobile',
    // ─ Address ──────────────────────────────────────────────────────────────
    address:             'address street residential location line',
    postOffice:          'post office',
    district:            'district city town locality',
    state:               'state province region',
    zipCode:             'zip postal pincode',
    // ─ Education ────────────────────────────────────────────────────────────
    educationExam:       'education degree qualification btech bsc mtech phd course',
    educationSchool:     'school university college institute board',
    educationYear:       'passing year graduation yop',
    educationMark:       'marks cgpa percentage score grade gpa',
    // ─ Career ───────────────────────────────────────────────────────────────
    jobTitle:            'designation title role position current job',
    currentSalary:       'salary ctc annual package compensation',
    expectedSalary:      'expected salary desired ctc',
    employedByCompany:   'employed before company previous',
    knowAnyoneInCompany: 'referral anyone know employee',
    // ─ Professional ─────────────────────────────────────────────────────────
    linkedin:            'linkedin profile',
    github:              'github repository code',
    portfolio:           'portfolio website blog',
    skills:              'skills technologies tools programming languages',
    experience:          'experience years professional background',
    kaggle:              'kaggle data science competition',
    authorizedWork:      'authorized legally work',
    requireSponsorship:  'sponsorship visa require',
  };

  const SKIP = new Set(['resumeFile', 'resumeFileName', 'resumeFileType', 'customQA', 'matchSensitivity']);

  searchItems = Object.keys(autofillData)
    .filter(k => !SKIP.has(k) && autofillData[k] !== '' && autofillData[k] != null)
    .map(key => ({
      key,
      value: autofillData[key],
      // Use ONLY the curated alias as search terms.
      // Never use camelToText(key) — it creates misleading substrings:
      // e.g. camelToText('mothersName') = 'mothers name' → 'name' contaminates the index.
      searchTerms: ALIASES[key] ?? key
    }));

  // Custom Q&A entries
  if (Array.isArray(profileData.customQA)) {
    profileData.customQA.forEach((qa, idx) => {
      const key = 'customQA_' + idx;
      autofillData[key] = qa.a;
      searchItems.push({ key, value: qa.a, searchTerms: qa.q });
    });
  }

  if (typeof Fuse === 'undefined') {
    console.error('[Smart Autofill] Fuse.js is not loaded!');
    return false;
  }

  fuse = new Fuse(searchItems, {
    includeScore:  true,
    threshold:     matchThreshold,
    ignoreLocation: true,
    keys:          ['searchTerms']
  });

  console.log(`[Smart Autofill] Ready. ${searchItems.length} fields indexed. Threshold: ${matchThreshold.toFixed(2)}`);
  return true;
}

// ====== VALUE SETTERS ======

function setInputValue(el, value) {
  el.focus();

  // Use native prototype setters to bypass React/Angular synthetic event wrappers
  const tag      = el.tagName.toLowerCase();
  const proto    = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter   = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

  if (setter) setter.call(el, value);
  else        el.value = value;

  el.dispatchEvent(new Event('input',  { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'End' }));
  el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: 'End' }));
  el.blur();
  el.dispatchEvent(new Event('blur', { bubbles: true }));

  highlight(el);
}

function setContentEditable(el, value) {
  el.focus();
  // execCommand works inside contenteditable and fires the real DOM mutation events
  // that frameworks like Google Forms' React setup listen to
  document.execCommand('selectAll',  false, null);
  document.execCommand('delete',     false, null);
  const inserted = document.execCommand('insertText', false, value);

  // Fallback if execCommand is unavailable (rare)
  if (!inserted || (el.innerText || '').trim() === '') {
    el.innerText = value;
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: value
    }));
  }

  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  el.blur();
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  highlight(el);
}

function highlight(el) {
  const prev = el.style.backgroundColor;
  el.style.backgroundColor = 'rgba(94, 23, 235, 0.15)';
  setTimeout(() => { if (el) el.style.backgroundColor = prev; }, 1600);
}

// ====== MATCH HELPER ======

function getBestMatch(contextInfo) {
  if (!fuse || !contextInfo) return null;

  const results = fuse.search(contextInfo);

  // Only accept a match if the score is within the user's threshold.
  // No keyword fallback — it causes cross-field contamination.
  if (results.length > 0 && results[0].score <= matchThreshold) {
    return results[0];
  }

  return null;
}

// ====== ELEMENT PROCESSOR ======

function processElement(el) {
  // Skip already-processed, disabled, hidden, or action elements
  if (
    processedElements.has(el) ||
    el.disabled ||
    el.readOnly ||
    ['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type)
  ) return;

  const isContentEditable =
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('role') === 'textbox';

  const contextInfo = getFieldContext(el);
  if (!contextInfo || contextInfo.length < 2) return;

  processedElements.add(el);
  console.log(`[Smart Autofill] Scanning: "${contextInfo}"`);

  // ── File upload ──────────────────────────────────────────────────────────
  if (el.type === 'file') {
    if (autofillData.resumeFile && autofillData.resumeFileName &&
        /resume|cv|upload|attach/i.test(contextInfo)) {
      try {
        const blob = base64ToBlob(autofillData.resumeFile, autofillData.resumeFileType);
        const file = new File([blob], autofillData.resumeFileName, { type: autofillData.resumeFileType });
        const dt   = new DataTransfer();
        dt.items.add(file);
        el.files = dt.files;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        filledCount++;
        console.log(`[Smart Autofill] => Resume: ${autofillData.resumeFileName}`);
      } catch (e) {
        console.error('[Smart Autofill] File upload failed:', e);
      }
    }
    return;
  }

  // ── Radio / Checkbox ─────────────────────────────────────────────────────
  if (el.type === 'radio' || el.type === 'checkbox') {
    const groupName = el.name;
    if (groupName && processedRadios.has(groupName)) return;

    // Ask fuzzy engine about the *question* (container text), not the option label
    const container = el.closest('fieldset, [role="group"], .radio-group, .form-group, div');
    const qCtx = container
      ? container.innerText.toLowerCase().substring(0, 200)
      : contextInfo;

    const match = getBestMatch(qCtx);
    if (!match) return;

    const target = String(autofillData[match.item.key] || '').toLowerCase().trim();
    if (!target) return;

    let hit = null;
    if (groupName) {
      document.querySelectorAll(`input[name="${groupName}"]`).forEach(radio => {
        const rv = radio.value.toLowerCase().trim();
        const rc = getFieldContext(radio);
        if (rv === target || rc.includes(target) || target.includes(rv)) hit = radio;
      });
    } else {
      if (el.value.toLowerCase().trim() === target || contextInfo.includes(target)) hit = el;
    }

    if (hit) {
      hit.checked = true;
      hit.dispatchEvent(new Event('change', { bubbles: true }));
      hit.dispatchEvent(new Event('click',  { bubbles: true }));
      if (groupName) processedRadios.add(groupName);
      filledCount++;
      console.log(`[Smart Autofill] => Radio: "${qCtx.substring(0, 60)}" → ${match.item.key} = "${target}"`);
    }
    return;
  }

  // ── Select dropdown ──────────────────────────────────────────────────────
  if (el.tagName.toLowerCase() === 'select') {
    const match = getBestMatch(contextInfo);
    if (!match) return;

    const val = String(autofillData[match.item.key] || '');
    if (!val) return;

    const optFuse = new Fuse(
      Array.from(el.options).map((opt, i) => ({ text: opt.text, index: i })),
      { keys: ['text'], threshold: 0.35, includeScore: true }
    );
    const optHits = optFuse.search(val);
    if (optHits.length > 0) {
      el.selectedIndex = optHits[0].item.index;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      filledCount++;
      console.log(`[Smart Autofill] => Select: "${contextInfo}" → "${val}"`);
    }
    return;
  }

  // ── ContentEditable (Google Forms, some React fields) ───────────────────
  if (isContentEditable) {
    const match = getBestMatch(contextInfo);
    if (!match) return;
    const val = String(autofillData[match.item.key] || '');
    if (!val) return;
    setContentEditable(el, val);
    filledCount++;
    console.log(`[Smart Autofill] => ContentEditable: "${contextInfo}" → ${match.item.key}`);
    return;
  }

  // ── Standard input / textarea ────────────────────────────────────────────
  const match = getBestMatch(contextInfo);
  if (!match) {
    console.log(`[Smart Autofill] No match: "${contextInfo}"`);
    return;
  }
  const val = String(autofillData[match.item.key] || '');
  if (!val) return;

  setInputValue(el, val);
  filledCount++;
  console.log(`[Smart Autofill] => Input: "${contextInfo}" → ${match.item.key} = "${val}" [score:${match.score.toFixed(3)}]`);
}

// ====== DOM HELPERS ======

const FILLABLE_SELECTOR =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),' +
  'textarea,' +
  'select,' +
  '[contenteditable="true"],' +
  '[role="textbox"]';

function getFillableElements(root = document) {
  return Array.from(root.querySelectorAll(FILLABLE_SELECTOR));
}

// ====== MUTATION OBSERVER (watches SPA / dynamically loaded fields) ======

const domObserver = new MutationObserver((mutations) => {
  if (!autofillEnabled || !fuse) return;

  const newEls = new Set();
  for (const mut of mutations) {
    for (const node of mut.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      getFillableElements(node).forEach(el => newEls.add(el));
      // Also check the node itself (in case it IS an input)
      if (node.matches?.(FILLABLE_SELECTOR)) newEls.add(node);
    }
  }
  newEls.forEach(processElement);
});

// ====== MAIN MESSAGE LISTENER ======

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'DO_AUTOFILL') return;

  // Reset all state so clicking "Autofill" twice works correctly
  autofillEnabled    = true;
  filledCount        = 0;
  processedElements  = new WeakSet();
  processedRadios    = new Set();
  fuse               = null;
  searchItems        = [];

  console.log('[Smart Autofill] Triggered.');

  chrome.storage.local.get(null, (storageData) => {
    if (chrome.runtime.lastError) {
      console.error('[Smart Autofill] Storage error:', chrome.runtime.lastError.message);
      sendResponse({ status: 'error', error: chrome.runtime.lastError.message });
      return;
    }

    // ── Read user-configured sensitivity (1–10) and convert to Fuse threshold ──
    const sensitivity = Number(storageData.matchSensitivity ?? 5);
    matchThreshold = (sensitivity / 20) + 0.15; // 1→0.20 | 5→0.40 | 10→0.65

    // ── Extract active profile data ──────────────────────────────────────────
    let profileData = {};
    if (storageData.profiles && storageData.activeProfileId) {
      const profile = storageData.profiles[storageData.activeProfileId];
      if (profile) profileData = profile.data || {};
    }

    if (!initFuse(profileData)) {
      sendResponse({ status: 'error', error: 'fuse_not_loaded' });
      return;
    }

    // Initial fill pass
    getFillableElements().forEach(processElement);

    // Watch for dynamically-added fields (single-page apps)
    domObserver.disconnect();
    domObserver.observe(document.body, { childList: true, subtree: true });

    console.log(`[Smart Autofill] Filled ${filledCount} field(s). Watching for dynamic content.`);
    sendResponse({ status: 'success', filledCount });
  });

  return true; // keep async channel open
});

} // end of window.__smartAutofillLoaded guard
