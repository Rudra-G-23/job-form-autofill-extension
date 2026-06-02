// ============================================================
//  LinkedIn Auto-Apply Bot — Content Script
//  Uses our Fuse.js fuzzy-match engine for smart field filling
//  combined with automation loop for multi-step form navigation
// ============================================================

(() => {
  // Prevent double-injection
  if (window.__linkedinBotLoaded) return;
  window.__linkedinBotLoaded = true;

  // ====== STATE ======
  let isRunning = false;
  let userExplicitlyClickedStart = false;
  let config = {};
  let appliedCount = 0;
  let skippedCount = 0;
  let appliedJobs = [];
  let lastActivityTime = Date.now();
  const STUCK_TIMEOUT = 120000; // 2 minutes

  // Fuse.js matching state
  let fuse = null;
  let autofillData = null;
  let searchItems = [];
  let matchThreshold = 0.40;

  // Resume
  let resumeFile = null;
  let resumeFileName = null;
  let resumeFileType = null;

  // ====== LOGGING ======
  function log(msg) {
    console.log('[LinkedIn Bot]', msg);
    try {
      chrome.runtime.sendMessage({ type: 'log', message: msg });
    } catch (e) { /* popup may be closed */ }
  }

  // ====== UTILITIES ======
  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function updateActivity() {
    lastActivityTime = Date.now();
  }

  function isStuck() {
    return (Date.now() - lastActivityTime) > STUCK_TIMEOUT;
  }

  // Protected click — only works if bot is running
  async function safeClick(element) {
    if (!isRunning || !userExplicitlyClickedStart) {
      console.error('[LinkedIn Bot] 🚨 SECURITY: click blocked — bot not running');
      return;
    }
    element.click();
    updateActivity();
    await wait(500);
  }

  // Protected fill — only works if bot is running
  function safeFill(input, value) {
    if (!isRunning || !userExplicitlyClickedStart) {
      console.error('[LinkedIn Bot] 🚨 SECURITY: fill blocked — bot not running');
      return;
    }
    const tag = input.tagName.toLowerCase();
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ====== FUSE.JS INITIALIZATION (reuses our engine) ======

  function camelToText(str) {
    if (!str) return '';
    return str.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase().trim();
  }

  function initFuse(profileData) {
    autofillData = { ...profileData };

    // Auto-derive firstName / lastName from applicantName
    if (autofillData.applicantName && !autofillData.firstName) {
      const nameParts = autofillData.applicantName.trim().split(/\s+/);
      autofillData.firstName = nameParts[0] || '';
      autofillData.lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
    }

    const ALIASES = {
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
      email:               'email mail',
      phone:               'mobile phone cell telephone contact',
      altPhone:            'alternative secondary emergency backup mobile',
      address:             'address street residential location line',
      postOffice:          'post office',
      district:            'district city town locality',
      state:               'state province region',
      zipCode:             'zip postal pincode',
      educationExam:       'education degree qualification btech bsc mtech phd course',
      educationSchool:     'school university college institute board',
      educationYear:       'passing year graduation yop',
      educationMark:       'marks cgpa percentage score grade gpa',
      jobTitle:            'designation title role position current job',
      currentSalary:       'salary ctc annual package compensation',
      expectedSalary:      'expected salary desired ctc',
      employedByCompany:   'employed before company previous',
      knowAnyoneInCompany: 'referral anyone know employee',
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
      log('❌ Fuse.js not loaded — cannot initialize fuzzy matching');
      return false;
    }

    fuse = new Fuse(searchItems, {
      includeScore: true,
      threshold: matchThreshold,
      ignoreLocation: true,
      keys: ['searchTerms']
    });

    log(`✅ Fuse initialized: ${searchItems.length} fields indexed, threshold ${matchThreshold.toFixed(2)}`);
    return true;
  }

  // ====== FIELD CONTEXT EXTRACTION ======

  function getFieldContext(el, modal) {
    const parts = [];
    if (el.placeholder) parts.push(el.placeholder);
    if (el.name) parts.push(camelToText(el.name));
    if (el.id) parts.push(camelToText(el.id));
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) parts.push(ariaLabel);

    // Standard <label> association
    let labelText = '';
    if (el.id) {
      const lbl = (modal || document).querySelector(`label[for="${el.id}"]`);
      if (lbl) labelText = lbl.innerText.trim();
    }
    if (!labelText) {
      const parentLbl = el.closest('label');
      if (parentLbl) labelText = parentLbl.innerText.trim();
    }

    // LinkedIn Easy Apply wrappers
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

    // Proximity fallback
    if (!labelText) {
      let cur = el.parentElement;
      for (let d = 0; d < 4 && cur; d++, cur = cur.parentElement) {
        const t = (cur.innerText || '').trim();
        if (t.length > 2 && t.length < 140) { labelText = t; break; }
      }
    }

    if (labelText) parts.push(labelText);

    return parts.join(' ')
      .replace(/\n/g, ' ')
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function getBestMatch(contextInfo) {
    if (!fuse || !contextInfo) return null;
    const results = fuse.search(contextInfo);
    if (results.length > 0 && results[0].score <= matchThreshold) {
      return results[0];
    }
    return null;
  }

  // ====== DAILY LIMIT DETECTION ======

  function checkDailyLimit() {
    try {
      const limitPatterns = [
        "You've reached today's Easy Apply limit",
        "reached today's Easy Apply limit",
        "Great effort applying today",
        "we limit daily submissions",
        "continue applying tomorrow",
        "Save this job and continue applying tomorrow",
        "exceeded the daily application limit",
        "daily Easy Apply limit",
        "limit daily submissions"
      ];

      const bodyText = document.body.innerText || '';
      for (const pattern of limitPatterns) {
        if (bodyText.toLowerCase().includes(pattern.toLowerCase())) {
          log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          log('🚫 DAILY LIMIT REACHED!');
          log(`   Message detected: "${pattern}"`);
          log(`   ✅ Applied: ${appliedCount}`);
          log(`   ⏭️  Skipped: ${skippedCount}`);
          log('⏰ You can continue applying tomorrow!');
          log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          return true;
        }
      }

      // Check error/modal elements
      const errorElements = document.querySelectorAll(
        '.artdeco-inline-feedback, .artdeco-toast-item, .artdeco-modal__content'
      );
      for (const element of errorElements) {
        const elementText = element.textContent || '';
        for (const pattern of limitPatterns) {
          if (elementText.toLowerCase().includes(pattern.toLowerCase())) {
            return true;
          }
        }
      }
      return false;
    } catch (error) {
      log(`⚠️ Error checking daily limit: ${error.message}`);
      return false;
    }
  }

  // ====== JOB FILTERING ======

  function shouldSkipByBlacklist(title, company, description, blacklistKeywords) {
    if (!blacklistKeywords || blacklistKeywords.trim() === '') return false;
    const keywords = blacklistKeywords.toLowerCase().split(',').map(k => k.trim()).filter(k => k);
    if (keywords.length === 0) return false;

    const jobText = (title + ' ' + company + ' ' + description).toLowerCase();
    for (const keyword of keywords) {
      if (jobText.includes(keyword)) {
        log(`⏭️ Skip (Blacklist): "${keyword}" found in job`);
        log(`   Title: ${title.substring(0, 50)}`);
        return true;
      }
    }
    return false;
  }

  function extractYearsRequired(text) {
    if (!text) return 0;
    const patterns = [
      /(\d+)\+?\s*(?:years?|yrs?)/gi,
      /(\d+)\+?\s*(?:ans?|années?)/gi,
      /(\d+)\+?\s*años?/gi,
      /(\d+)\+?\s*jahre?/gi,
      /(\d+)\+?\s*anni?/gi
    ];
    const years = [];
    patterns.forEach(pattern => {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const num = parseInt(match[1]);
        if (num > 0 && num <= 20) years.push(num);
      }
    });
    return years.length > 0 ? Math.max(...years) : 0;
  }

  function shouldSkipByExperience(jobCard, maxYearsRequired) {
    if (!maxYearsRequired || maxYearsRequired <= 0) return false;
    try {
      const title = jobCard.querySelector('.job-card-list__title, .artdeco-entity-lockup__title')?.textContent || '';
      const subtitle = jobCard.querySelector('.job-card-container__metadata-item')?.textContent || '';
      const yearsRequired = extractYearsRequired(title + ' ' + subtitle);
      if (yearsRequired > 0 && yearsRequired > maxYearsRequired) {
        log(`⏭️ Skip: ${yearsRequired}+ years required (max: ${maxYearsRequired})`);
        return true;
      }
    } catch (error) { /* don't skip on error */ }
    return false;
  }

  // ====== STUCK / LOADING DETECTION ======

  function checkForStuckLoadingPopup() {
    try {
      const loadingIndicators = document.querySelectorAll(
        '.artdeco-loader, .loading, .spinner, [role="progressbar"]'
      );
      for (const indicator of loadingIndicators) {
        if (indicator.offsetParent !== null) return true;
      }

      const modal = document.querySelector('.jobs-easy-apply-modal');
      if (modal && modal.offsetParent !== null) {
        const buttons = modal.querySelectorAll('button');
        const clickableButtons = Array.from(buttons).filter(b =>
          !b.disabled && b.offsetParent !== null
        );
        if (clickableButtons.length === 0) return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  async function isPageLoadingSlow() {
    try {
      if (document.readyState !== 'complete') return true;
      const spinners = document.querySelectorAll(
        '[role="progressbar"], .artdeco-loader, .loading-spinner, .spinner, .loading'
      );
      for (const spinner of spinners) {
        if (spinner.offsetParent !== null) return true;
      }
      const modal = document.querySelector('.jobs-easy-apply-modal');
      if (!modal || !modal.offsetParent) return true;
      return false;
    } catch (error) {
      return true;
    }
  }

  // ====== DISCARD APPLICATION ======

  async function discardApplication() {
    log('🚀 DISCARD: Starting safe discard sequence...');
    const discardTexts = ['discard', 'annuler', 'cancel', 'abandonner', 'descarter'];

    try {
      // Check for stuck loading popup
      if (checkForStuckLoadingPopup()) {
        log('🚨 Stuck loading popup detected — refreshing page');
        location.reload();
        await wait(2000);
        return true;
      }

      // Step 1: X / Close button
      const closeButtons = document.querySelectorAll(
        'button[aria-label*="Dismiss"], button[aria-label*="Close"], button.artdeco-modal__dismiss'
      );
      for (const btn of closeButtons) {
        if (btn.offsetParent) {
          btn.click();
          await wait(1000);

          const discardBtn = Array.from(document.querySelectorAll('button')).find(b =>
            b.offsetParent && discardTexts.some(t => b.textContent.trim().toLowerCase().includes(t))
          );
          if (discardBtn) {
            discardBtn.click();
            await wait(1500);
          }

          const modal = document.querySelector('.jobs-easy-apply-modal');
          if (!modal || modal.offsetParent === null) {
            log('✅ Modal closed!');
            return true;
          }
        }
      }

      // Step 2: ESC key
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, bubbles: true }));
      await wait(1000);

      // Step 3: Find discard/cancel buttons
      for (let attempt = 1; attempt <= 3; attempt++) {
        const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const btn of allButtons) {
          if (!btn.offsetParent) continue;
          const btnText = btn.textContent.trim().toLowerCase();
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          const isDiscardButton = discardTexts.some(text =>
            btnText === text || btnText.includes(text) || ariaLabel.includes(text)
          );
          if (isDiscardButton) {
            btn.click();
            await wait(300);
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await wait(1500);

            const modal = document.querySelector('.jobs-easy-apply-modal');
            if (!modal || modal.offsetParent === null) {
              log('✅ Modal closed!');
              return true;
            }
          }
        }
        await wait(1000);
      }

      log('❌ DISCARD FAILED: Could not close modal');
      return false;
    } catch (error) {
      log(`❌ Error discarding: ${error.message}`);
      return false;
    }
  }

  // ====== DONE BUTTON FINDER ======

  async function findAndClickDoneButton(contextElement = document, maxAttempts = 15) {
    const doneTexts = ['Done', 'Submit application', 'Dismiss', 'Close'];
    let doneBtn = null;

    for (let attempt = 0; attempt < maxAttempts && !doneBtn; attempt++) {
      await wait(1000);

      // Method 1: Span text search
      for (const targetText of doneTexts) {
        const spans = Array.from(contextElement.querySelectorAll('span.artdeco-button__text, span'));
        for (const span of spans) {
          if (span.textContent.trim() === targetText) {
            let clickable = span.closest('button, [role="button"], .artdeco-button');
            if (!clickable) clickable = span;
            if (clickable.offsetParent !== null) {
              doneBtn = clickable;
              break;
            }
          }
        }
        if (doneBtn) break;
      }

      // Method 2: Direct button search
      if (!doneBtn) {
        const buttons = Array.from(contextElement.querySelectorAll('button, [role="button"]'));
        for (const btn of buttons) {
          const btnText = btn.textContent.trim();
          if (doneTexts.includes(btnText) && btn.offsetParent !== null) {
            doneBtn = btn;
            break;
          }
        }
      }

      // Method 3: aria-label
      if (!doneBtn) {
        for (const targetText of doneTexts) {
          const ariaBtn = contextElement.querySelector(
            `button[aria-label*="${targetText}"], [role="button"][aria-label*="${targetText}"]`
          );
          if (ariaBtn && ariaBtn.offsetParent !== null) {
            doneBtn = ariaBtn;
            break;
          }
        }
      }
    }

    if (doneBtn) {
      try {
        doneBtn.click();
        await wait(500);
        updateActivity();
        await wait(700);
        return { success: true, clicked: true };
      } catch (e) {
        return { success: false, clicked: false, reason: 'Click failed' };
      }
    }
    return { success: false, clicked: false, reason: 'Button not found' };
  }

  // ====== FORM FILLING (FUSE.JS POWERED) ======

  function fillModalFields(modal) {
    if (!fuse || !autofillData) return;

    // 1. TEXT INPUTS
    const textInputs = modal.querySelectorAll(
      'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], textarea'
    );
    for (const input of textInputs) {
      if (input.value && input.value.trim()) continue; // Skip if filled
      const context = getFieldContext(input, modal);
      if (!context || context.length < 2) continue;

      const match = getBestMatch(context);
      if (match) {
        const val = String(autofillData[match.item.key] || '');
        if (val) {
          safeFill(input, val);
          log(`  ✅ Input: "${context.substring(0, 40)}" → ${match.item.key} = "${val.substring(0, 30)}" [score:${match.score.toFixed(3)}]`);
        }
      }
    }

    // 2. FILE INPUTS (Resume/CV Upload) — try to select existing first
    let resumeAlreadySelected = false;
    const resumeSelectors = [
      'input[type="radio"][name*="resume"]',
      'input[type="radio"][name*="cv"]',
      'input[type="radio"][id*="resume"]',
      'input[type="radio"][id*="document"]',
      '[data-test-document-upload-item]',
      '.jobs-document-upload-redesign-card',
      '.jobs-document-upload__container',
      '.document-upload-item'
    ];

    for (const selector of resumeSelectors) {
      const resumeOptions = modal.querySelectorAll(selector);
      if (resumeOptions.length > 0) {
        for (const option of resumeOptions) {
          if (option.offsetParent !== null) {
            if (option.type === 'radio') {
              if (!option.checked) {
                const label = modal.querySelector(`label[for="${option.id}"]`);
                if (label) label.click(); else option.click();
                log('  ✅ Selected existing resume');
              }
              resumeAlreadySelected = true;
            } else {
              const isSelected = option.classList.contains('selected') ||
                option.getAttribute('aria-selected') === 'true' ||
                option.querySelector('input[type="radio"]:checked');
              if (!isSelected) option.click();
              resumeAlreadySelected = true;
            }
            break;
          }
        }
        if (resumeAlreadySelected) break;
      }
    }

    // Upload resume if none selected and we have one
    if (!resumeAlreadySelected && resumeFile && resumeFileName && resumeFileType) {
      const fileInputs = modal.querySelectorAll('input[type="file"]');
      for (const fileInput of fileInputs) {
        if (fileInput.files && fileInput.files.length > 0) continue;
        const context = getFieldContext(fileInput, modal);
        if (/resume|cv|curriculum|vitae|upload.*document|file/i.test(context)) {
          try {
            const base64Data = resumeFile.includes(',') ? resumeFile.split(',')[1] : resumeFile;
            const binaryString = atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
            const file = new File([bytes], resumeFileName, { type: resumeFileType });
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            fileInput.files = dataTransfer.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            log(`  ✅ Resume uploaded: ${resumeFileName}`);
          } catch (e) {
            log(`  ❌ Resume upload failed: ${e.message}`);
          }
        }
      }
    }

    // 3. CHECKBOXES (consent, terms)
    const checkboxes = modal.querySelectorAll('input[type="checkbox"]');
    for (const checkbox of checkboxes) {
      if (checkbox.id === 'follow-company-checkbox') continue;
      const checkboxLabel = modal.querySelector(`label[for="${checkbox.id}"]`);
      const labelText = checkboxLabel ? checkboxLabel.textContent.toLowerCase() : '';
      if (labelText.match(/consent|agree|terms|conditions|policy|privacy|accept/)) {
        if (!checkbox.checked) {
          checkboxLabel ? checkboxLabel.click() : checkbox.click();
          log(`  ✅ Checkbox: ${labelText.substring(0, 40)}`);
        }
      }
    }

    // 4. RADIO BUTTONS — use Fuse for matching question to stored answer
    const radios = modal.querySelectorAll('fieldset[data-test-form-builder-radio-button-form-component]');
    for (const fieldset of radios) {
      const questionLabel = fieldset.querySelector('legend, span[class*="title"]');
      const questionText = questionLabel ? questionLabel.textContent.trim() : '';
      const questionLower = questionText.toLowerCase();

      const radioInputs = fieldset.querySelectorAll('input[type="radio"]');
      let answered = false;

      // Try fuzzy match first via our profile data
      const match = getBestMatch(questionLower);
      if (match) {
        const desiredAnswer = String(autofillData[match.item.key] || '').toLowerCase().trim();
        if (desiredAnswer) {
          for (const radio of radioInputs) {
            const radioLabel = fieldset.querySelector(`label[for="${radio.id}"]`);
            const radioText = radioLabel ? radioLabel.textContent.trim().toLowerCase() : '';
            if (radioText === desiredAnswer || radioText.includes(desiredAnswer) || desiredAnswer.includes(radioText)) {
              if (!radio.checked) {
                radioLabel ? radioLabel.click() : radio.click();
                log(`  ✅ Radio (fuzzy): "${questionText.substring(0, 30)}" → "${desiredAnswer}"`);
                answered = true;
              }
              break;
            }
          }
        }
      }

      // Fallback: click "Yes" for common LinkedIn questions
      if (!answered) {
        let desiredAnswer = 'yes';
        if (questionLower.match(/visa|sponsor/i)) desiredAnswer = config.visaSponsorship || 'no';
        else if (questionLower.match(/author|legal.*work|eligib.*work|right.*work/i)) desiredAnswer = config.legallyAuthorized || 'yes';
        else if (questionLower.match(/relocat|willing.*move/i)) desiredAnswer = config.willingToRelocate || 'yes';
        else if (questionLower.match(/security.*clearance/i)) desiredAnswer = 'no';
        else if (questionLower.match(/driver.*license|driving.*license/i)) desiredAnswer = config.driversLicense || 'yes';

        for (const radio of radioInputs) {
          const radioLabel = fieldset.querySelector(`label[for="${radio.id}"]`);
          const radioText = radioLabel ? radioLabel.textContent.trim().toLowerCase() : '';
          const isYes = radioText.match(/^(yes|oui|sí|si|ja|y)$/);
          const isNo = radioText.match(/^(no|non|nein|n)$/);
          if ((desiredAnswer === 'yes' && isYes) || (desiredAnswer === 'no' && isNo)) {
            if (!radio.checked) {
              radioLabel ? radioLabel.click() : radio.click();
              log(`  ✅ Radio (config): "${questionText.substring(0, 30)}" → ${desiredAnswer}`);
              answered = true;
            }
            break;
          }
        }
      }

      // Last resort: first option
      if (!answered && radioInputs.length > 0 && !radioInputs[0].checked) {
        const firstLabel = fieldset.querySelector(`label[for="${radioInputs[0].id}"]`);
        firstLabel ? firstLabel.click() : radioInputs[0].click();
        log(`  ⚠️ Radio (fallback first): "${questionText.substring(0, 30)}"`);
      }
    }

    // 5. SELECT DROPDOWNS (native)
    const selects = modal.querySelectorAll('select');
    for (const select of selects) {
      if (select.selectedIndex > 0) continue;
      const context = getFieldContext(select, modal);
      const match = getBestMatch(context);

      if (match) {
        const val = String(autofillData[match.item.key] || '');
        if (val) {
          // Fuzzy match option text
          const optFuse = new Fuse(
            Array.from(select.options).map((opt, i) => ({ text: opt.text, index: i })),
            { keys: ['text'], threshold: 0.35, includeScore: true }
          );
          const optHits = optFuse.search(val);
          if (optHits.length > 0) {
            select.selectedIndex = optHits[0].item.index;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            log(`  ✅ Select: "${context.substring(0, 30)}" → "${val.substring(0, 30)}"`);
          }
        }
      }

      // If still not selected, pick first non-placeholder option
      if (select.selectedIndex <= 0 && select.options.length > 1) {
        select.value = select.options[1].value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        log(`  ⚠️ Select (fallback): picked "${select.options[1].text.substring(0, 30)}"`);
      }
    }

    // 6. CUSTOM LINKEDIN DROPDOWNS (artdeco listbox)
    const customDropdowns = modal.querySelectorAll('button[aria-haspopup="listbox"], button.artdeco-dropdown__trigger');
    for (const dropdown of customDropdowns) {
      // Check if already has a selection
      const currentText = dropdown.textContent.trim().toLowerCase();
      if (currentText && !currentText.includes('select') && !currentText.includes('choose')) continue;

      const context = getFieldContext(dropdown, modal);
      dropdown.click();
      // We need a small synchronous-ish wait here — use setTimeout workaround
      // This will be handled in the step loop's overall wait
    }
  }

  // Handle autocomplete/typeahead after filling city/location fields
  async function handleAutocomplete(modal) {
    const textInputs = modal.querySelectorAll('input[type="text"]');
    for (const input of textInputs) {
      const context = getFieldContext(input, modal);
      if (context.match(/city|ville|ciudad|stadt|location|localisation/)) {
        // Wait for autocomplete dropdown
        await wait(1000);
        const dropdownSelectors = [
          '[role="listbox"]',
          '.basic-typeahead__selectable',
          '.artdeco-typeahead__results',
          'ul[role="listbox"]'
        ];

        for (const selector of dropdownSelectors) {
          const dropdown = document.querySelector(selector);
          if (dropdown && dropdown.offsetParent !== null) {
            const firstOption = dropdown.querySelector('[role="option"]:first-child, li:first-child');
            if (firstOption) {
              firstOption.click();
              log(`  ✅ Autocomplete: ${firstOption.textContent.substring(0, 30)}`);
              await wait(500);
            }
            break;
          }
        }
      }
    }
  }

  // ====== COUNTER UPDATES ======

  function updateAppliedCount() {
    chrome.storage.local.set({ appliedCount });
    try { chrome.runtime.sendMessage({ type: 'updateCount', count: appliedCount }); } catch (e) {}
  }

  function updateSkippedCount() {
    chrome.storage.local.set({ skippedCount });
    try { chrome.runtime.sendMessage({ type: 'updateSkippedCount', count: skippedCount }); } catch (e) {}
  }

  function saveAppliedJobsToStorage() {
    chrome.storage.local.set({ appliedJobs });
  }

  // ====== MAIN LOOP ======

  async function mainLoop() {
    if (!isRunning || !userExplicitlyClickedStart) {
      log('🚨 SECURITY: mainLoop blocked — not explicitly started');
      return;
    }

    if (!fuse) {
      log('❌ Fuse not initialized — cannot start');
      isRunning = false;
      return;
    }

    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🚀 BOT STARTED — All security checks passed');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const isCollectionsPage = window.location.href.includes('/jobs/collections/');
    log(`📋 Page type: ${isCollectionsPage ? 'COLLECTIONS (infinite scroll)' : 'SEARCH (pagination)'}`);

    while (isRunning) {
      try {
        // Daily limit check
        if (checkDailyLimit()) {
          log('⛔ Stopping: Daily limit reached');
          await stopBot('Daily limit reached');
          break;
        }

        // Stuck check
        if (isStuck()) {
          log('🚨 STUCK DETECTED: No activity for 2 minutes — refreshing');
          location.reload();
          await wait(2500);
          updateActivity();
          continue;
        }

        // Find job cards
        let jobCards = document.querySelectorAll('li[data-occludable-job-id]');
        if (jobCards.length === 0 && isCollectionsPage) {
          jobCards = document.querySelectorAll('.jobs-search-results__list-item, .scaffold-layout__list-item');
        }

        if (jobCards.length === 0) {
          log('No jobs found. Waiting 5s...');
          if (isStuck()) {
            location.reload();
            await wait(2500);
            updateActivity();
          }
          await wait(2500);
          continue;
        }

        log(`📋 ${jobCards.length} jobs found`);
        updateActivity();

        // Process each job
        for (let i = 0; i < jobCards.length; i++) {
          if (!isRunning) break;

          const job = jobCards[i];
          const jobId = job.getAttribute('data-occludable-job-id');
          log(`\n--- Job ${i + 1}/${jobCards.length} (ID: ${jobId}) ---`);

          // Clean up leftover modals
          const leftoverModal = document.querySelector('.jobs-easy-apply-modal');
          if (leftoverModal && leftoverModal.offsetParent !== null) {
            log('⚠️ Cleaning up leftover modal...');
            await discardApplication();
            await wait(1000);
            const stillOpen = document.querySelector('.jobs-easy-apply-modal');
            if (stillOpen && stillOpen.offsetParent !== null) {
              skippedCount++;
              updateSkippedCount();
              continue;
            }
          }

          // Get job info
          const jobTitle = job.querySelector('.job-card-list__title, .artdeco-entity-lockup__title')?.textContent.trim() || '';
          const jobCompany = job.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle')?.textContent.trim() || '';
          const jobDescription = job.querySelector('.job-card-container__metadata-item')?.textContent.trim() || '';

          // Blacklist filter
          if (shouldSkipByBlacklist(jobTitle, jobCompany, jobDescription, config.blacklistKeywords)) {
            skippedCount++;
            updateSkippedCount();
            continue;
          }

          // Experience filter
          if (shouldSkipByExperience(job, parseInt(config.maxYearsRequired))) {
            skippedCount++;
            updateSkippedCount();
            continue;
          }

          // Scroll and click job
          job.scrollIntoView({ block: 'start', behavior: 'smooth' });
          await wait(500);
          const link = job.querySelector('a');
          if (link) {
            await safeClick(link);
            await wait(600);
          }

          // Find Easy Apply button
          let easyApplyBtn = document.querySelector('button.jobs-apply-button[aria-label*="Easy"]');
          if (!easyApplyBtn && isCollectionsPage) {
            easyApplyBtn = document.querySelector('button[aria-label*="Easy Apply"]');
          }

          if (!easyApplyBtn) {
            log('Not Easy Apply, skip');
            skippedCount++;
            updateSkippedCount();
            continue;
          }

          await safeClick(easyApplyBtn);
          await wait(800);

          // Handle safety reminder modal
          const safetyModal = document.querySelector('[role="dialog"], .artdeco-modal');
          if (safetyModal && safetyModal.offsetParent !== null) {
            const safetyText = safetyModal.textContent.toLowerCase();
            if (safetyText.includes('safety reminder') || safetyText.includes('continue applying')) {
              const continueBtn = Array.from(safetyModal.querySelectorAll('button')).find(btn =>
                btn.textContent.trim().toLowerCase().includes('continue')
              );
              if (continueBtn) {
                await safeClick(continueBtn);
                await wait(1000);
              }
            }
          }

          // Check daily limit after clicking Easy Apply
          if (checkDailyLimit()) {
            await stopBot('Daily limit reached');
            break;
          }

          // Verify modal appeared
          const modalCheck = document.querySelector('.jobs-easy-apply-modal');
          if (!modalCheck || modalCheck.offsetParent === null) {
            log('⚠️ Easy Apply modal did not appear');
            await wait(1000);
            if (checkDailyLimit()) {
              await stopBot('Daily limit reached');
              break;
            }
            skippedCount++;
            updateSkippedCount();
            continue;
          }

          // ====== MULTI-STEP FORM FILLING ======
          const jobLink = job.querySelector('a')?.href || window.location.href;
          let step = 0;
          const applicationStartTime = Date.now();
          const applicationTimeout = 180000; // 3 minutes max

          while (step < 10) {
            step++;

            // Timeout check
            if (Date.now() - applicationStartTime > applicationTimeout) {
              log('⏰ TIMEOUT 3min — discarding');
              await discardApplication();
              skippedCount++;
              updateSkippedCount();
              break;
            }

            // Stuck loading popup
            if (checkForStuckLoadingPopup()) {
              log('🚨 Stuck loading popup — refreshing');
              location.reload();
              await wait(2000);
              skippedCount++;
              updateSkippedCount();
              break;
            }

            // Check validation errors
            let modal = document.querySelector('.jobs-easy-apply-modal');
            if (modal) {
              const errors = modal.querySelectorAll('[role="alert"], .artdeco-inline-feedback--error, .fb-form-element-label__error');
              let hasBlockingError = false;
              for (const error of errors) {
                if (error.offsetParent !== null) {
                  const errorText = error.textContent.toLowerCase();
                  if (errorText.includes('please enter') || errorText.includes('valid answer') ||
                      errorText.includes('required') || errorText.includes('must be') ||
                      errorText.includes('invalid')) {
                    log(`❌ STUCK: Validation error: ${error.textContent.substring(0, 50)}`);
                    await discardApplication();
                    skippedCount++;
                    updateSkippedCount();
                    hasBlockingError = true;
                    break;
                  }
                }
              }
              if (hasBlockingError) break;
            }

            // Check loading screen
            if (await isPageLoadingSlow()) {
              const loadingStart = Date.now();
              while (await isPageLoadingSlow()) {
                if (Date.now() - loadingStart > 20000) {
                  log('⏰ Loading timeout 20s — discarding');
                  await discardApplication();
                  skippedCount++;
                  updateSkippedCount();
                  break;
                }
                await wait(1000);
              }
              if (Date.now() - loadingStart > 20000) break;
            }

            log(`Step ${step}`);

            // Find modal
            modal = document.querySelector('.jobs-easy-apply-modal');
            if (!modal) {
              log('Modal closed');
              break;
            }

            // Fill all fields using Fuse.js
            fillModalFields(modal);
            await handleAutocomplete(modal);
            await wait(1500);

            // Find Next or Submit button
            const nextBtn = Array.from(modal.querySelectorAll('button')).find(btn => {
              const text = btn.textContent.toLowerCase();
              return text.includes('next') || text.includes('suivant') ||
                     text.includes('review') || text.includes('submit') || text.includes('soumettre');
            });

            if (!nextBtn) {
              log('No Next/Submit button found');
              break;
            }

            const isSubmit = nextBtn.textContent.toLowerCase().includes('submit') ||
                            nextBtn.textContent.toLowerCase().includes('soumettre');

            // Unfollow company before submit
            if (isSubmit) {
              log('Before Submit: unfollowing company...');
              nextBtn.scrollIntoView({ block: 'end', behavior: 'smooth' });
              await wait(800);

              const followCheckbox = modal.querySelector('input[id="follow-company-checkbox"]') ||
                                    modal.querySelector('input[id*="follow-company"][type="checkbox"]');
              if (followCheckbox && followCheckbox.checked) {
                const label = modal.querySelector(`label[for="${followCheckbox.id}"]`);
                if (label) await safeClick(label);
                else followCheckbox.click();
                log('✅ Company unfollowed');
              }
              await wait(500);
            }

            // Check if button is disabled
            if (nextBtn.disabled || nextBtn.getAttribute('aria-disabled') === 'true') {
              if (step > 2) {
                log('❌ STUCK: Button disabled after multiple attempts — discarding');
                await discardApplication();
                skippedCount++;
                updateSkippedCount();
                break;
              }
              await wait(1000);
              continue;
            }

            await safeClick(nextBtn);
            await wait(1000);

            // Check for validation errors after clicking next
            const stillSameModal = document.querySelector('.jobs-easy-apply-modal');
            if (stillSameModal && !isSubmit) {
              const errorSelectors = ['[role="alert"]', '.artdeco-inline-feedback--error', '.fb-form-element-label__error'];
              let errorFound = false;
              for (const selector of errorSelectors) {
                const errors = stillSameModal.querySelectorAll(selector);
                for (const error of errors) {
                  if (error.offsetParent !== null) {
                    const errorText = error.textContent.toLowerCase();
                    if (errorText.includes('please enter') || errorText.includes('required') ||
                        errorText.includes('must be') || errorText.includes('invalid')) {
                      log(`❌ VALIDATION ERROR: ${error.textContent.substring(0, 60)}`);
                      await discardApplication();
                      skippedCount++;
                      updateSkippedCount();
                      errorFound = true;
                      break;
                    }
                  }
                }
                if (errorFound) break;
              }
              if (errorFound) break;
            }

            // Submit completed!
            if (isSubmit) {
              log('✅ Submit clicked!');
              appliedCount++;
              appliedJobs.push({
                title: jobTitle,
                company: jobCompany,
                link: jobLink,
                date: new Date().toISOString()
              });
              updateAppliedCount();
              saveAppliedJobsToStorage();

              // Wait and close Done modal
              await wait(1000);
              let doneModalCheck = document.querySelector('.jobs-easy-apply-modal, [role="dialog"], .artdeco-modal');
              if (!doneModalCheck || doneModalCheck.offsetParent === null) {
                log('✅ Application completed (modal auto-closed)');
              } else {
                await wait(1000);
                const result = await findAndClickDoneButton(document, 15);
                if (!result.clicked) {
                  const m = document.querySelector('.jobs-easy-apply-modal');
                  if (m && m.offsetParent !== null) await discardApplication();
                }

                // Check for "Application sent" modal
                await wait(1500);
                const sentModal = document.querySelector('.jobs-easy-apply-modal, [role="dialog"], .artdeco-modal');
                if (sentModal && sentModal.offsetParent !== null) {
                  const sentResult = await findAndClickDoneButton(sentModal, 8);
                  if (!sentResult.clicked) await discardApplication();
                }
              }

              log('✅ Application completed — moving to next job');
              await wait(500);
              break;
            }
          }
        }

        // Bot stopped during processing
        if (!isRunning) {
          log('🛑 Bot stopped during processing');
          break;
        }

        // ====== PAGINATION / INFINITE SCROLL ======
        log('🔍 Looking for next page...');
        let nextPageClicked = false;

        // Collections: infinite scroll
        if (isCollectionsPage) {
          const jobListContainer = document.querySelector(
            '.jobs-search-results-list, .scaffold-layout__list-container, .jobs-search-results__list'
          );
          if (jobListContainer) {
            const currentJobCount = jobCards.length;
            jobListContainer.scrollTo({ top: jobListContainer.scrollHeight, behavior: 'smooth' });
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            log('📜 Scrolled down to load more jobs...');
            await wait(2000);
            const newJobCount = document.querySelectorAll(
              'li[data-occludable-job-id], .jobs-search-results__list-item, .scaffold-layout__list-item'
            ).length;
            if (newJobCount > currentJobCount) {
              log(`✅ Loaded ${newJobCount - currentJobCount} more jobs`);
              nextPageClicked = true;
            }
          }
        }

        // Search: pagination
        if (!nextPageClicked) {
          const pagination = document.querySelector('.jobs-search-pagination__pages');
          if (pagination) {
            const activeBtn = pagination.querySelector('button.active, button[aria-current="true"], li.active button');
            if (activeBtn) {
              const currentPage = parseInt(activeBtn.textContent);
              const nextPageBtn = pagination.querySelector(`button[aria-label="Page ${currentPage + 1}"]`) ||
                                  pagination.querySelector(`button[data-test-pagination-page-btn="${currentPage + 1}"]`);
              if (nextPageBtn && nextPageBtn.offsetParent !== null) {
                log(`✅ Navigating to page ${currentPage + 1}`);
                await safeClick(nextPageBtn);
                await wait(1000);
                nextPageClicked = true;
              }
            }
          }
        }

        // Fallback: "Next" button
        if (!nextPageClicked) {
          const nextButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
          for (const btn of nextButtons) {
            if (!btn.offsetParent) continue;
            const btnText = btn.textContent.trim().toLowerCase();
            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (btnText === 'next' || btnText === 'siguiente' || ariaLabel.includes('next')) {
              const isPaginationNext = btn.closest('.jobs-search-pagination') ||
                                       btn.closest('[class*="pagination"]') ||
                                       ariaLabel.includes('page');
              if (isPaginationNext) {
                await safeClick(btn);
                await wait(1000);
                nextPageClicked = true;
                break;
              }
            }
          }
        }

        if (!nextPageClicked) {
          log('📋 No more pages — end of job list');
          break;
        }

      } catch (error) {
        log(`Erreur: ${error.message}`);
        await wait(1500);
      }
    }

    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log(`🏁 BOT FINISHED — Applied: ${appliedCount}, Skipped: ${skippedCount}`);
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    await stopBot('Finished');
  }

  // ====== BOT CONTROL ======

  async function stopBot(reason = 'Stopped') {
    isRunning = false;
    userExplicitlyClickedStart = false;
    await chrome.storage.local.set({ isRunning: false });
    try {
      chrome.runtime.sendMessage({
        type: 'botStopped',
        reason,
        appliedCount,
        skippedCount
      });
    } catch (e) { /* popup closed */ }
    log(`🛑 Bot stopped: ${reason}`);
  }

  // ====== MESSAGE LISTENER ======

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
      try {
        if (request.action === 'startBot') {
          // Load profile data from storage
          const storageData = await chrome.storage.local.get(null);

          // Read sensitivity
          const sensitivity = Number(storageData.matchSensitivity ?? 5);
          matchThreshold = (sensitivity / 20) + 0.15;

          // Extract active profile data
          let profileData = {};
          if (storageData.profiles && storageData.activeProfileId) {
            const profile = storageData.profiles[storageData.activeProfileId];
            if (profile) profileData = profile.data || {};
          }

          // Load bot config
          config = await chrome.storage.local.get([
            'blacklistKeywords', 'maxYearsRequired', 'autoNextPage',
            'visaSponsorship', 'legallyAuthorized', 'willingToRelocate', 'driversLicense'
          ]);

          // Load counters
          const local = await chrome.storage.local.get([
            'appliedCount', 'skippedCount', 'appliedJobs'
          ]);
          appliedCount = local.appliedCount || 0;
          skippedCount = local.skippedCount || 0;
          appliedJobs = local.appliedJobs || [];

          // Load resume
          resumeFile = profileData.resumeFile || null;
          resumeFileName = profileData.resumeFileName || null;
          resumeFileType = profileData.resumeFileType || null;

          if (resumeFile) log(`📄 Resume loaded: ${resumeFileName}`);
          else log('ℹ️ No resume uploaded');

          // Init Fuse.js
          if (!initFuse(profileData)) {
            sendResponse({ success: false, error: 'Fuse.js not loaded' });
            return;
          }

          // Set security flags
          isRunning = true;
          userExplicitlyClickedStart = true;
          await chrome.storage.local.set({ isRunning: true });
          updateActivity();

          sendResponse({ success: true, message: 'Bot started' });

          try { chrome.runtime.sendMessage({ type: 'botStarted' }); } catch (e) {}

          // Start loop (don't await — runs in background)
          mainLoop();

        } else if (request.action === 'stopBot') {
          await stopBot('User clicked Stop');
          sendResponse({ success: true, message: 'Bot stopped' });

        } else if (request.action === 'exportJobs') {
          sendResponse({ jobs: appliedJobs });

        } else if (request.action === 'resetCounters') {
          appliedCount = 0;
          skippedCount = 0;
          appliedJobs = [];
          await chrome.storage.local.set({ appliedCount: 0, skippedCount: 0, appliedJobs: [] });
          updateAppliedCount();
          updateSkippedCount();
          sendResponse({ success: true });

        } else if (request.action === 'clearAppliedJobs') {
          appliedJobs = [];
          await chrome.storage.local.set({ appliedJobs: [] });
          sendResponse({ success: true });

        } else if (request.action === 'getBotStatus') {
          sendResponse({
            isRunning,
            appliedCount,
            skippedCount,
            appliedJobsCount: appliedJobs.length
          });
        }
      } catch (error) {
        log(`❌ Message handler error: ${error.message}`);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // async response
  });

  // ====== INITIALIZATION ======

  // Clear running state on load (safety)
  isRunning = false;
  userExplicitlyClickedStart = false;
  chrome.storage.local.set({ isRunning: false });

  // Load counters for display
  chrome.storage.local.get(['appliedCount', 'skippedCount', 'appliedJobs'], (state) => {
    appliedCount = state.appliedCount || 0;
    skippedCount = state.skippedCount || 0;
    appliedJobs = state.appliedJobs || [];
  });

  console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #5e17eb; font-weight: bold;');
  console.log('%c🤖 Smart Autofill LinkedIn Bot — Ready', 'color: #5e17eb; font-weight: bold; font-size: 14px;');
  console.log('%c⏸️ Waiting for START command...', 'color: #f59e0b; font-weight: bold;');
  console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #5e17eb; font-weight: bold;');

})();
