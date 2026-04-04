document.addEventListener('DOMContentLoaded', () => {
  loadOptions();
  
  // File Upload Handling
  const btnBrowse = document.getElementById('btn-browse-file');
  const fileInput = document.getElementById('resumeFile');
  const fileNameDisplay = document.getElementById('file-name-display');

  btnBrowse.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) {
      fileNameDisplay.textContent = file.name;
      
      // Read file to base64 for storage
      const reader = new FileReader();
      reader.onload = (e) => {
        const base64String = e.target.result;
        chrome.storage.local.set({ 
          resumeFile: base64String,
          resumeFileName: file.name,
          resumeFileType: file.type
        });
      };
      reader.readAsDataURL(file);
    }
  });

  document.getElementById('btn-save').addEventListener('click', saveOptions);
});

function loadOptions() {
  chrome.storage.local.get(null, (data) => {
    const inputs = document.querySelectorAll('#options-form input, #options-form textarea');
    inputs.forEach(input => {
      if (input.type === 'radio') {
        if (data[input.name] === input.value) {
          input.checked = true;
        }
      } else if (input.type !== 'file') {
        if (data[input.name]) {
          input.value = data[input.name];
        }
      }
    });

    if (data.resumeFileName) {
      document.getElementById('file-name-display').textContent = data.resumeFileName;
    }
  });
}

function saveOptions() {
  const inputs = document.querySelectorAll('#options-form input, #options-form textarea');
  let dataToSave = {};

  inputs.forEach(input => {
    if (input.type === 'radio') {
      if (input.checked) {
        dataToSave[input.name] = input.value;
      }
    } else if (input.type !== 'file') {
      dataToSave[input.name] = input.value;
    }
  });

  chrome.storage.local.set(dataToSave, () => {
    const statusMsg = document.getElementById('save-status');
    statusMsg.textContent = 'Settings saved successfully!';
    statusMsg.className = 'status-msg success';
    
    setTimeout(() => {
      statusMsg.textContent = '';
    }, 3000);
  });
}
