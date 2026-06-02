let appState = {
  activeProfileId: 'profile_default',
  matchSensitivity: 5,
  profiles: {
    'profile_default': {
      name: 'Default Profile',
      data: {
        customQA: []
      }
    }
  }
};

document.addEventListener('DOMContentLoaded', () => {
  initOptions();

  // Sensitivity slider — live value display
  const slider = document.getElementById('matchSensitivity');
  const sliderVal = document.getElementById('sensitivityValue');
  slider.addEventListener('input', () => {
    sliderVal.textContent = slider.value;
    appState.matchSensitivity = Number(slider.value);
  });

  // Profile Manager Listeners
  document.getElementById('profileSelector').addEventListener('change', (e) => {
    appState.activeProfileId = e.target.value;
    saveStateToStorage(() => loadDataToForm());
  });

  document.getElementById('btn-add-profile').addEventListener('click', () => {
    const name = prompt('Enter a name for the new profile:');
    if (name && name.trim()) {
      const newId = 'profile_' + Date.now();
      appState.profiles[newId] = {
        name: name.trim(),
        data: { customQA: [] }
      };
      appState.activeProfileId = newId;
      saveStateToStorage(() => {
        renderProfileSelector();
        loadDataToForm();
      });
    }
  });

  document.getElementById('btn-rename-profile').addEventListener('click', () => {
    const profile = appState.profiles[appState.activeProfileId];
    if (!profile) return;
    const name = prompt('Rename profile to:', profile.name);
    if (name && name.trim()) {
      profile.name = name.trim();
      saveStateToStorage(() => renderProfileSelector());
    }
  });

  document.getElementById('btn-delete-profile').addEventListener('click', () => {
    if (Object.keys(appState.profiles).length <= 1) {
      alert('You must have at least one profile.');
      return;
    }
    if (confirm('Are you sure you want to delete this profile?')) {
      delete appState.profiles[appState.activeProfileId];
      appState.activeProfileId = Object.keys(appState.profiles)[0];
      saveStateToStorage(() => {
        renderProfileSelector();
        loadDataToForm();
      });
    }
  });

  // Custom QA Listeners
  document.getElementById('btn-add-qa').addEventListener('click', () => addQARow());

  // File Upload Handling
  const btnBrowse = document.getElementById('btn-browse-file');
  const fileInput = document.getElementById('resumeFile');
  const fileNameDisplay = document.getElementById('file-name-display');

  btnBrowse.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) {
      fileNameDisplay.textContent = file.name;
      const reader = new FileReader();
      reader.onload = (e) => {
        const profile = appState.profiles[appState.activeProfileId];
        profile.data.resumeFile     = e.target.result;
        profile.data.resumeFileName = file.name;
        profile.data.resumeFileType = file.type;
      };
      reader.readAsDataURL(file);
    }
  });

  document.getElementById('btn-save').addEventListener('click', saveOptions);
});

function initOptions() {
  chrome.storage.local.get(null, (storageData) => {
    if (!storageData.profiles) {
      // Migration: old flat data → default profile
      const oldKeys = Object.keys(storageData);
      if (oldKeys.length > 0) {
        let migratedData = { customQA: [] };
        oldKeys.forEach(k => { migratedData[k] = storageData[k]; });
        appState.profiles['profile_default'].data = migratedData;
      }
      saveStateToStorage(() => { renderProfileSelector(); loadDataToForm(); });
      return;
    }

    appState = { matchSensitivity: 5, ...storageData };

    // Set slider
    const slider = document.getElementById('matchSensitivity');
    const sliderVal = document.getElementById('sensitivityValue');
    slider.value = appState.matchSensitivity ?? 5;
    sliderVal.textContent = slider.value;

    renderProfileSelector();
    loadDataToForm();
  });
}

function renderProfileSelector() {
  const sel = document.getElementById('profileSelector');
  sel.innerHTML = '';
  
  for (const [id, profile] of Object.entries(appState.profiles)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = profile.name;
    if (appState.activeProfileId === id) {
      opt.selected = true;
    }
    sel.appendChild(opt);
  }
}

function loadDataToForm() {
  const profile = appState.profiles[appState.activeProfileId];
  if (!profile) return;
  const data = profile.data || {};

  // Reset all inputs first
  const inputs = document.querySelectorAll('#options-form input, #options-form textarea, #options-form select');
  inputs.forEach(input => {
    if (input.type === 'radio' || input.type === 'checkbox') {
      input.checked = false;
    } else if (input.type !== 'file') {
      input.value = '';
    }
  });

  // Load flat fields
  inputs.forEach(input => {
    const val = data[input.name];
    if (val !== undefined && val !== null) {
      if (input.type === 'radio') {
        if (input.value === val) input.checked = true;
      } else if (input.type === 'checkbox') {
        input.checked = val;
      } else if (input.type !== 'file') {
        input.value = val;
      }
    }
  });

  // Load File Display
  if (data.resumeFileName) {
    document.getElementById('file-name-display').textContent = data.resumeFileName;
  } else {
    document.getElementById('file-name-display').textContent = 'No file selected';
  }

  // Load Custom QA
  const qaContainer = document.getElementById('custom-qa-container');
  qaContainer.innerHTML = '';
  const customQA = data.customQA || [];
  customQA.forEach(qa => addQARow(qa.q, qa.a));
}

function addQARow(qVal = "", aVal = "") {
  const container = document.getElementById('custom-qa-container');
  
  const row = document.createElement('div');
  row.className = 'qa-row';
  
  const qDiv = document.createElement('div');
  qDiv.className = 'input-group';
  qDiv.style.flex = "1";
  qDiv.innerHTML = `<label>Match Text / Question</label><input type="text" class="qa-q" placeholder="e.g. Do you have a valid passport?" value="${qVal}">`;
  
  const aDiv = document.createElement('div');
  aDiv.className = 'input-group';
  aDiv.style.flex = "1";
  aDiv.innerHTML = `<label>Answer</label><input type="text" class="qa-a" placeholder="e.g. Yes" value="${aVal}">`;
  
  const btnDel = document.createElement('button');
  btnDel.type = 'button';
  btnDel.className = 'btn-danger';
  btnDel.textContent = 'X';
  btnDel.onclick = () => row.remove();
  
  row.appendChild(qDiv);
  row.appendChild(aDiv);
  row.appendChild(btnDel);
  
  container.appendChild(row);
}

function saveOptions() {
  const profile = appState.profiles[appState.activeProfileId];
  if (!profile) return;

  // Retain resume files (loaded async, not in form inputs)
  const { resumeFile, resumeFileName, resumeFileType } = profile.data;

  let newData = {};

  // Save all form inputs EXCEPT the sensitivity slider and file input
  // (matchSensitivity is stored at top-level of appState, not inside profile)
  const inputs = document.querySelectorAll(
    '#options-form input:not(.qa-q):not(.qa-a):not([name="matchSensitivity"]), #options-form textarea, #options-form select'
  );
  inputs.forEach(input => {
    if (input.type === 'radio') {
      if (input.checked) newData[input.name] = input.value;
    } else if (input.type === 'checkbox') {
      newData[input.name] = input.checked;
    } else if (input.type !== 'file') {
      newData[input.name] = input.value;
    }
  });

  // Auto-fill full name if only first/last provided
  if (!newData.applicantName && (newData.firstName || newData.lastName)) {
    newData.applicantName = [newData.firstName, newData.lastName].filter(Boolean).join(' ');
  }

  // Re-attach resume
  if (resumeFile)     newData.resumeFile     = resumeFile;
  if (resumeFileName) newData.resumeFileName = resumeFileName;
  if (resumeFileType) newData.resumeFileType = resumeFileType;

  // Compile Custom Q&A
  newData.customQA = [];
  document.querySelectorAll('.qa-row').forEach(row => {
    const q = row.querySelector('.qa-q').value.trim();
    const a = row.querySelector('.qa-a').value.trim();
    if (q) newData.customQA.push({ q, a });
  });

  profile.data = newData;

  // Save sensitivity as a global pref (top-level in appState)
  appState.matchSensitivity = Number(document.getElementById('matchSensitivity').value);

  saveStateToStorage(() => {
    const statusMsg = document.getElementById('save-status');
    statusMsg.textContent = 'Profile saved!';
    statusMsg.className = 'status-msg success';
    setTimeout(() => { statusMsg.textContent = ''; }, 3000);
  });
}

function saveStateToStorage(callback) {
  chrome.storage.local.set(appState, callback);
}
