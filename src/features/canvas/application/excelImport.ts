import * as XLSX from 'xlsx';

/**
 * Opens a hidden file picker and resolves with the selected File,
 * or null when the user cancels the dialog.
 */
export function pickExcelFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';

    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', handleWindowFocus);
      input.remove();
      resolve(file);
    };

    const handleWindowFocus = () => {
      // Give the change event a moment to fire before treating it as cancel.
      window.setTimeout(() => {
        finish(input.files && input.files.length > 0 ? input.files[0] : null);
      }, 300);
    };

    input.addEventListener('change', () => {
      finish(input.files && input.files.length > 0 ? input.files[0] : null);
    });

    document.body.appendChild(input);
    window.addEventListener('focus', handleWindowFocus);
    input.click();
  });
}

/**
 * Reads an Excel / CSV file and extracts every non-empty cell as one prompt.
 */
export async function extractPromptsFromExcel(file: File): Promise<string[]> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });

  const prompts: string[] = [];
  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    rows.forEach((row) => {
      row.forEach((cell) => {
        if (typeof cell === 'string' && cell.trim() !== '') {
          prompts.push(cell.trim());
        } else if (typeof cell === 'number') {
          prompts.push(String(cell));
        }
      });
    });
  });

  return prompts;
}