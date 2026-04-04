// Utility to convert Base64 to Blob
function base64ToBlob(base64, type = 'application/octet-stream') {
  const binaryString = window.atob(base64.split(',')[1]);
  const length = binaryString.length;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type });
}

// Convert camelCase key to readable text for better fuzzy matching
function camelToText(text) {
  return text.replace(/([A-Z])/g, " $1").toLowerCase();
}

function getFieldContext(el) {
  let context = [];
  
  // 1. Placeholder
  if (el.placeholder) context.push(el.placeholder.toLowerCase());
  
  // 2. Name attribute
  if (el.name) context.push(camelToText(el.name));
  
  // 3. ID attribute
  if (el.id) context.push(camelToText(el.id));
  
  // 4. aria-label
  if (el.getAttribute('aria-label')) context.push(el.getAttribute('aria-label').toLowerCase());

  // 5. Associated Label
  let labelText = '';
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label) labelText = label.innerText.toLowerCase();
  }
  
  // 6. Closest parent label
  if (!labelText) {
    const parentLabel = el.closest('label');
    if (parentLabel && parentLabel.innerText) {
      labelText = parentLabel.innerText.toLowerCase();
    }
  }

  // 7. Text immediately preceding the input (heuristic)
  if (!labelText && el.parentElement) {
    const parentText = el.parentElement.innerText;
    if (parentText && parentText.length < 50) {
      labelText = parentText.toLowerCase();
    }
  }

  if (labelText) context.push(labelText);

  // Clean up newlines and extra spaces
  return context.join(" ").replace(/\n/g, " ").trim();
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "DO_AUTOFILL") {
    chrome.storage.local.get(null, (data) => {
      // Setup data points for Fuse.js
      const keys = Object.keys(data).filter(k => k !== 'resumeFile' && k !== 'resumeFileName' && k !== 'resumeFileType');
      
      const searchItems = keys.map(key => ({
        key: key,
        value: data[key],
        searchTerms: camelToText(key) + " " + key // "firstName first name"
      }));

      // Add alias terms for specific data science / generic fields
      searchItems.forEach(item => {
        if (item.key === 'firstName') item.searchTerms += " first given";
        if (item.key === 'lastName') item.searchTerms += " last family sur";
        if (item.key === 'email') item.searchTerms += " e-mail mail address";
        if (item.key === 'phone') item.searchTerms += " mobile cell contact telephone";
        if (item.key === 'linkedin') item.searchTerms += " linked in profile network url";
        if (item.key === 'github') item.searchTerms += " git hub code repository open source url";
        if (item.key === 'portfolio') item.searchTerms += " website personal blog url";
        if (item.key === 'experience') item.searchTerms += " history background work employment detail summary paragraph";
        if (item.key === 'skills') item.searchTerms += " technologies stack tools programming languages";
        if (item.key === 'kaggle') item.searchTerms += " kaggle competition data science profile url";
        if (item.key === 'coverLetter') item.searchTerms += " cover letter message note to hiring manager";
        if (item.key === 'authorizedWork') item.searchTerms += " legally authorized work us sponsorship right law";
        if (item.key === 'requireSponsorship') item.searchTerms += " require sponsorship visa h1b now future";
      });

      const fuseOptions = {
        includeScore: true,
        threshold: 0.5, // Lower threshold = exact match needed. 0.5 is somewhat fuzzy.
        keys: ['searchTerms']
      };
      
      // Fuse is loaded from background/manifest or inline
      let fuse;
      if (typeof Fuse !== 'undefined') {
        fuse = new Fuse(searchItems, fuseOptions);
      } else {
        console.error("Fuse.js not found!");
        sendResponse({status: "error", error: "fuse_not_loaded"});
        return;
      }

      let filledCount = 0;
      
      // Collect visible inputs
      const elements = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select'));
      
      // Group radios globally by name so we only process them once
      let processedRadios = new Set();

      elements.forEach(el => {
        if (el.disabled || el.readOnly) return;

        // --- Handle File Uploads ---
        if (el.type === 'file') {
          if (data.resumeFile && data.resumeFileName) {
            try {
              const fileContext = getFieldContext(el);
              // usually if there's only one file field, it's for resume. But let's check context.
              if (fileContext.includes('resume') || fileContext.includes('cv') || fileContext.includes('upload')) {
                const blob = base64ToBlob(data.resumeFile, data.resumeFileType);
                const file = new File([blob], data.resumeFileName, { type: data.resumeFileType });
                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(file);
                el.files = dataTransfer.files;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                filledCount++;
                console.log(`[Smart Autofill] Filled File input with: ${data.resumeFileName}`);
              }
            } catch (e) {
              console.error("File upload autofill failed", e);
            }
          }
          return;
        }

        const contextInfo = getFieldContext(el);
        if (!contextInfo) return; // Cannot infer what this field is

        // --- Handle Radios and Checkboxes ---
        if (el.type === 'radio' || el.type === 'checkbox') {
          const groupName = el.name;
          if (groupName && processedRadios.has(groupName)) return; // Already solved for this radio group
          
          // Try to match the overarching question of the radio group (e.g. from a fieldset legend or parent container text)
          let questionContext = contextInfo;
          let container = el.closest('fieldset, .radio-group, .form-group, div');
          if (container && container.innerText) {
            questionContext = container.innerText.toLowerCase().substring(0, 150); // limit length
          }

          const results = fuse.search(questionContext);
          if (results.length > 0 && results[0].score < 0.6) {
            const bestMatchKey = results[0].item.key;
            const targetValue = data[bestMatchKey]; // e.g. "Yes" or "No"

            if (targetValue) {
              // Find the specific radio/checkbox in this group that matches the targetValue ("Yes" or "No")
              let matchingInput = null;
              
              if (groupName) {
                const groupInputs = document.querySelectorAll(`input[name="${groupName}"]`);
                groupInputs.forEach(radio => {
                   const radioContext = getFieldContext(radio);
                   const valStr = targetValue.toLowerCase();
                   if (radio.value.toLowerCase() === valStr || radioContext.includes(valStr) || radio.id.toLowerCase().includes(valStr)) {
                     matchingInput = radio;
                   }
                });
              } else {
                 const radioContext = getFieldContext(el);
                 const valStr = targetValue.toLowerCase();
                 if (el.value.toLowerCase() === valStr || radioContext.includes(valStr)) {
                   matchingInput = el;
                 }
              }

              if (matchingInput) {
                matchingInput.checked = true;
                matchingInput.dispatchEvent(new Event('change', { bubbles: true }));
                matchingInput.dispatchEvent(new Event('click', { bubbles: true })); // some frameworks need click
                if (groupName) processedRadios.add(groupName);
                filledCount++;
                console.log(`[Smart Autofill] Checked Radio/Checkbox: ${bestMatchKey} -> ${targetValue}`);
              }
            }
          }
          return;
        }

        // --- Handle Text, URL, Email, Textarea, Select ---
        // Exclude inputs that are checkboxes or radios (already handled above)
        
        const results = fuse.search(contextInfo);
        
        if (results.length > 0) {
          const match = results[0];
          // We rely on score < 0.6 as a threshold for confidence
          if (match.score < 0.6 && data[match.item.key]) {
             
             // If Select dropdown, we do a fuzzy search of the options
             if (el.tagName.toLowerCase() === 'select') {
                let options = Array.from(el.options);
                let targetFuzzy = new Fuse(options.map((opt, i) => ({ text: opt.text, index: i })), { keys: ['text'], threshold: 0.4 });
                let optResults = targetFuzzy.search(data[match.item.key]);
                if (optResults.length > 0) {
                  el.selectedIndex = optResults[0].item.index;
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  filledCount++;
                  console.log(`[Smart Autofill] Selected Dropdown for [${contextInfo}] (Matched: ${match.item.key}, Score: ${match.score.toFixed(2)})`);
                }
             } else {
                // Text input / textarea
                el.value = data[match.item.key];
                
                // Trigger events so frontend frameworks (React/Vue) detect the change
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
                
                // Add a visual highlight
                const oldBg = el.style.backgroundColor;
                el.style.backgroundColor = 'rgba(94, 23, 235, 0.1)';
                setTimeout(() => el.style.backgroundColor = oldBg, 1500);

                filledCount++;
                console.log(`[Smart Autofill] Filled Field [${contextInfo}] with: ${match.item.key} (Score: ${match.score.toFixed(2)})`);
             }
          }
        }
      });

      sendResponse({ status: "success", filledCount: filledCount });
    });

    return true; // Keep message channel open for async
  }
});
