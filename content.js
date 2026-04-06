// ====== UTILITIES ======

function base64ToBlob(base64, type = 'application/octet-stream') {
  const binaryString = window.atob(base64.split(',')[1]);
  const length = binaryString.length;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type });
}

function camelToText(text) {
  if (!text) return "";
  return text.replace(/([A-Z])/g, " $1").toLowerCase();
}

// ====== FIELD CONTEXT EXTRACTION ======

function getFieldContext(el) {
  let context = [];

  // 1. Attributes
  if (el.placeholder) context.push(el.placeholder);
  if (el.name) context.push(camelToText(el.name));
  if (el.id) context.push(camelToText(el.id));
  if (el.getAttribute('aria-label')) context.push(el.getAttribute('aria-label'));
  if (el.getAttribute('aria-labelledby')) {
     const labelledBy = document.getElementById(el.getAttribute('aria-labelledby'));
     if (labelledBy) context.push(labelledBy.innerText);
  }

  // 2. Labels
  let labelText = '';
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label) labelText = label.innerText;
  }
  if (!labelText) {
    const parentLabel = el.closest('label');
    if (parentLabel && parentLabel.innerText) labelText = parentLabel.innerText;
  }
  
  // 3. Fallbacks for dynamic forms (Google Forms, etc.)
  if (!labelText) {
    const container = el.closest('[role="listitem"], .geS5n, .Qr7Oae, .zEbbtd');
    if (container) {
       const heading = container.querySelector('[role="heading"]');
       if (heading) {
          labelText = heading.innerText;
       } else {
          labelText = container.innerText.substring(0, 150);
       }
    }
  }

  // 4. Proximity Text
  if (!labelText && el.parentElement) {
    let current = el.parentElement;
    let distance = 0;
    while (current && distance < 3) {
      const text = current.innerText || "";
      if (text.trim().length > 0 && text.trim().length < 150) {
          labelText = text;
          if (text.trim().length > 3) break;
      }
      current = current.parentElement;
      distance++;
    }
  }

  if (labelText) context.push(labelText);

  // Normalize: lower case, remove punctuation, trim
  return context.join(" ")
    .replace(/\n/g, " ")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ====== STATE ======
let autofillEnabled = false;
let autofillData = null;
let fuse = null;
let searchItems = [];
let processedElements = new WeakSet();
let filledCount = 0;
let processedRadios = new Set();


// ====== CORE LOGIC ======

function initFuse(appState) {
  let data = appState;
  if (appState.profiles && appState.activeProfileId && appState.profiles[appState.activeProfileId]) {
    data = appState.profiles[appState.activeProfileId].data;
  }
  autofillData = data;

  const keys = Object.keys(data).filter(k => 
    k !== 'resumeFile' && k !== 'resumeFileName' && k !== 'resumeFileType' && k !== 'customQA'
  );

  searchItems = keys.map(key => ({
    key: key,
    value: data[key],
    searchTerms: camelToText(key) + " " + key
  }));

  if (data.customQA && Array.isArray(data.customQA)) {
    data.customQA.forEach((qa, idx) => {
      const customKey = 'customQA_' + idx;
      searchItems.push({
        key: customKey,
        value: qa.a,
        searchTerms: qa.q
      });
      autofillData[customKey] = qa.a;
    });
  }

  // Term Definitions
  const aliases = {
    applicantName: "first last full name given family sur applicant",
    fathersName: "father dad parent guardian",
    mothersName: "mother mom parent",
    dob: "date of birth dob birthday born",
    gender: "gender sex orientation",
    bloodGroup: "blood group type rhesus rh",
    maritalStatus: "marital status marriage single spouse",
    religion: "religion belief faith",
    caste: "caste category community obc gen sc st",
    nationality: "nationality citizenship legal right citizen country status",
    email: "e-mail mail address",
    phone: "mobile cell contact telephone",
    altPhone: "alternative emergency secondary backup mobile",
    address: "address street line residential current permanent location",
    postOffice: "post office po ps police station",
    district: "district city town locality",
    state: "state province region",
    zipCode: "zip code pincode postal",
    educationExam: "education examination passed degree qualification course btech bsc highest level",
    educationSchool: "school university college institute institution board",
    educationYear: "year of passing yop graduation finished completed dates",
    educationMark: "marks cgpa percentage score grade performance gpa",
    currentSalary: "current salary ctc drawn earning paying compensation base",
    expectedSalary: "expected salary ctc expectation requirement desired compensation",
    employedByCompany: "employed by this company before worked here past employee",
    knowAnyoneInCompany: "know anyone from this company referral relative friend network connect",
    linkedin: "linked in profile network url",
    github: "git hub code repository open source url",
    portfolio: "website personal blog url",
    skills: "technologies stack tools programming languages",
    experience: "history background work employment detail summary paragraph duties responsibilities title role setup description",
    kaggle: "kaggle competition data science profile url",
    authorizedWork: "legally authorized work us sponsorship right law",
    requireSponsorship: "require sponsorship visa h1b now future"
  };

  searchItems.forEach(item => {
    if (aliases[item.key]) {
      item.searchTerms += " " + aliases[item.key];
    }
  });

  const fuseOptions = {
    includeScore: true,
    threshold: 0.65, // Tighter string-distance threshold (60-70% goal)
    ignoreLocation: true,
    keys: ['searchTerms']
  };

  if (typeof Fuse !== 'undefined') {
    fuse = new Fuse(searchItems, fuseOptions);
  } else {
    console.error("[Smart Autofill] Fuse.js not found!");
  }
}

function setValueRobustly(el, value) {
  el.focus();
  
  // Try native React/Wiz setters
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;

  if (el.tagName.toLowerCase() === 'textarea' && nativeTextAreaValueSetter) {
     nativeTextAreaValueSetter.call(el, value);
  } else if (nativeInputValueSetter) {
     nativeInputValueSetter.call(el, value);
  } else {
     el.value = value;
  }
  
  // Trigger DOM events for frameworks
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, key: 'Enter' }));
  el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, composed: true, key: 'Enter' }));
  
  el.blur();
  el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));

  // Visual highlight
  const oldBg = el.style.backgroundColor;
  el.style.backgroundColor = 'rgba(94, 23, 235, 0.1)';
  setTimeout(() => { if (el) el.style.backgroundColor = oldBg; }, 1500);
}

function processElement(el) {
  if (processedElements.has(el) || el.disabled || el.readOnly || el.type === 'hidden' || el.type === 'submit' || el.type === 'button') {
    return;
  }

  // Handle Divs acting as textboxes (ContentEditable / Role=Textbox)
  const isContentEditable = el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox';

  // Extract Context
  const contextInfo = getFieldContext(el);
  if (!contextInfo) return; 

  console.log(`[Smart Autofill] Analyzing field: "${contextInfo}"`);
  processedElements.add(el); // Mark as processed

  // File Upload
  if (el.type === 'file') {
    if (autofillData.resumeFile && autofillData.resumeFileName) {
      if (contextInfo.includes('resume') || contextInfo.includes('cv') || contextInfo.includes('upload')) {
        try {
          const blob = base64ToBlob(autofillData.resumeFile, autofillData.resumeFileType);
          const file = new File([blob], autofillData.resumeFileName, { type: autofillData.resumeFileType });
          const dt = new DataTransfer();
          dt.items.add(file);
          el.files = dt.files;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          filledCount++;
          console.log(`[Smart Autofill] => Filled File: ${autofillData.resumeFileName}`);
        } catch (e) {
          console.error("[Smart Autofill] File autofill failed", e);
        }
      }
    }
    return;
  }

  // Radios / Checkboxes
  if (el.type === 'radio' || el.type === 'checkbox') {
    const groupName = el.name;
    if (groupName && processedRadios.has(groupName)) return;

    let questionContext = contextInfo;
    let container = el.closest('fieldset, .radio-group, .form-group, div');
    if (container && container.innerText) {
      questionContext = container.innerText.toLowerCase().substring(0, 150);
    }

    const results = fuse.search(questionContext);
    if (results.length > 0 && results[0].score < 0.6) { // Score ~ 60%
      const matchKey = results[0].item.key;
      const targetValue = autofillData[matchKey];

      if (targetValue) {
        let matchingInput = null;
        if (groupName) {
          document.querySelectorAll(`input[name="${groupName}"]`).forEach(radio => {
             const rc = getFieldContext(radio);
             const tv = targetValue.toLowerCase();
             if (radio.value.toLowerCase() === tv || rc.includes(tv) || radio.id.toLowerCase().includes(tv)) matchingInput = radio;
          });
        } else {
           const tv = targetValue.toLowerCase();
           if (el.value.toLowerCase() === tv || contextInfo.includes(tv)) matchingInput = el;
        }

        if (matchingInput) {
          matchingInput.checked = true;
          matchingInput.dispatchEvent(new Event('change', { bubbles: true }));
          matchingInput.dispatchEvent(new Event('click', { bubbles: true }));
          if (groupName) processedRadios.add(groupName);
          filledCount++;
          console.log(`[Smart Autofill] => Checked Radio/Box. Field: ${contextInfo} | Map: ${matchKey} (${targetValue}) | Score: ${results[0].score.toFixed(2)}`);
        }
      }
    }
    return;
  }

  // Text, URL, Email, Textarea, Select, ContentEditable
  const results = fuse.search(contextInfo);
  let match = null;

  if (results.length > 0 && results[0].score <= 0.65) {
     match = results[0];
  } else {
     // Fallback strict substring match
     for (let item of searchItems) {
         const terms = item.searchTerms.split(" ").filter(t => t.length > 3);
         for (let t of terms) {
             if (contextInfo.includes(t)) {
                 match = { item: item, score: 0.5 };
                 break;
             }
         }
         if (match) break;
     }
  }

  if (match && autofillData[match.item.key]) {
      const val = autofillData[match.item.key];

      if (el.tagName.toLowerCase() === 'select') {
          let options = Array.from(el.options);
          let targetFuzzy = new Fuse(options.map((opt, i) => ({ text: opt.text, index: i })), { keys: ['text'], threshold: 0.4 });
          let optResults = targetFuzzy.search(val);
          if (optResults.length > 0) {
            el.selectedIndex = optResults[0].item.index;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            filledCount++;
            console.log(`[Smart Autofill] => Selected Dropdown. Field: ${contextInfo} | Map: ${match.item.key} | Score: ${match.score.toFixed(2)}`);
          }
      } else if (isContentEditable) {
          // React/Google Forms editable divs
          el.focus();
          el.innerText = val;
          el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          el.blur();
          filledCount++;
          
          const oldBg = el.style.backgroundColor;
          el.style.backgroundColor = 'rgba(94, 23, 235, 0.1)';
          setTimeout(() => { if (el) el.style.backgroundColor = oldBg; }, 1500);

          console.log(`[Smart Autofill] => Filled ContentEditable. Field: ${contextInfo} | Map: ${match.item.key} | Score: ${match.score.toFixed(2)}`);
      } else {
          // Standard Inputs / Textareas
          setValueRobustly(el, val);
          filledCount++;
          console.log(`[Smart Autofill] => Filled Input. Field: ${contextInfo} | Map: ${match.item.key} | Score: ${match.score.toFixed(2)}`);
      }
  } else if (!match) {
     console.log(`[Smart Autofill] No solid match for field: "${contextInfo}"`);
  }
}

function getFillableElements(root = document) {
  return Array.from(root.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select, [contenteditable="true"], [role="textbox"]'));
}

// ====== MUTATION OBSERVER ======
const domObserver = new MutationObserver((mutations) => {
  if (!autofillEnabled || !fuse) return;
  
  for (const mutation of mutations) {
    if (mutation.addedNodes.length > 0) {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const elements = getFillableElements(node);
          if (node.matches && node.matches('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select, [contenteditable="true"], [role="textbox"]')) {
              elements.push(node);
          }
          elements.forEach(processElement);
        }
      });
    }
  }
});


// ====== EVENT LISTENER ======
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "DO_AUTOFILL") {
    
    // Enable state
    autofillEnabled = true;
    filledCount = 0;
    
    console.log("[Smart Autofill] Autofill Initialized on Document.");

    chrome.storage.local.get(null, (appState) => {
      initFuse(appState);
      if (!fuse) {
        sendResponse({status: "error", error: "fuse_not_loaded"});
        return;
      }

      // Initial Pass
      const elements = getFillableElements();
      elements.forEach(processElement);

      // Start observing for dynamically added elements
      domObserver.observe(document.body, { childList: true, subtree: true });
      
      console.log(`[Smart Autofill] Initial Pass Complete. Filled: ${filledCount}. Now watching for new elements...`);

      sendResponse({ status: "success", filledCount: filledCount });
    });

    return true; // Keep channel open
  }
});
