const side = 16;
const pixelCount = side * side;
const blankPixels = '0'.repeat(pixelCount);
const svgNamespace = 'http://www.w3.org/2000/svg';
const validPixels = value => typeof value === 'string' && value.length === pixelCount && /^[0-9a-f]{256}$/i.test(value);

function initializeEditor(editor) {
  if (editor.dataset.pixelInitialized === 'true') return;
  const input = editor.querySelector('[data-avatar-pixels]');
  const grid = editor.querySelector('[data-pixel-grid]');
  const preview = editor.querySelector('[data-pixel-preview] svg');
  const paletteButtons = [...editor.querySelectorAll('[data-pixel-color]')];
  const cells = [...editor.querySelectorAll('[data-pixel-index]')];
  const undoButton = editor.querySelector('[data-pixel-undo]');
  const clearButton = editor.querySelector('[data-pixel-clear]');
  const count = editor.querySelector('[data-pixel-count]');
  if (!input || !grid || !preview || !undoButton || !clearButton || !count ||
      paletteButtons.length !== side || cells.length !== pixelCount) return;
  const palette = paletteButtons.map((button, index) =>
    button.dataset.pixelColor === index.toString(16) &&
    /^(?:transparent|#[0-9a-f]{6})$/i.test(button.dataset.pixelFill ?? '')
      ? button.dataset.pixelFill : null);
  if (palette.some(color => color === null) || palette[0] !== 'transparent') return;
  editor.dataset.pixelInitialized = 'true';
  const initialPixels = validPixels(input.value) ? input.value.toLowerCase() : blankPixels;
  let pixels = initialPixels;
  let selectedColor = '3';
  let focusIndex = 0;
  let stroke = null;
  let rendered = '';
  const history = [];
  const pixelRects = Array.from({ length: pixelCount }, () => null);
  const enabled = () => !input.matches(':disabled');
  preview.replaceChildren();

  function remember() {
    history.push(pixels);
    if (history.length > 20) history.shift();
  }

  function update() {
    input.value = pixels;
    let painted = 0;
    for (let index = 0; index < pixelCount; index += 1) {
      const color = pixels[index];
      if (color !== '0') painted += 1;
      if (rendered[index] === color) continue;
      cells[index].className = `pixel-paint-cell pixel-color-${color}`;
      cells[index].setAttribute('aria-selected', String(color !== '0'));
      if (color === '0') {
        pixelRects[index]?.remove();
        pixelRects[index] = null;
      } else {
        if (!pixelRects[index]) {
          const tile = document.createElementNS(svgNamespace, 'rect');
          tile.setAttribute('x', String(index % side));
          tile.setAttribute('y', String(Math.floor(index / side)));
          tile.setAttribute('width', '1');
          tile.setAttribute('height', '1');
          preview.append(tile);
          pixelRects[index] = tile;
        }
        pixelRects[index].setAttribute('fill', palette[Number.parseInt(color, 16)]);
      }
    }
    rendered = pixels;
    count.textContent = `${painted} / ${pixelCount}`;
    undoButton.disabled = !enabled() || history.length === 0;
    clearButton.disabled = !enabled() || painted === 0;
  }

  function notifyChange() {
    update();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function paint(index, color = selectedColor, notify = true) {
    if (!enabled() || !Number.isInteger(index) || index < 0 || index >= pixelCount ||
        !/^[0-9a-f]$/.test(color) || pixels[index] === color) return false;
    if (!stroke || !stroke.changed) remember();
    if (stroke) stroke.changed = true;
    pixels = pixels.slice(0, index) + color + pixels.slice(index + 1);
    if (notify) notifyChange();
    return true;
  }

  function paintLine(from, to) {
    let x = from % side;
    let y = Math.floor(from / side);
    const endX = to % side;
    const endY = Math.floor(to / side);
    const deltaX = Math.abs(endX - x);
    const deltaY = -Math.abs(endY - y);
    const stepX = x < endX ? 1 : -1;
    const stepY = y < endY ? 1 : -1;
    let error = deltaX + deltaY;
    let changed = false;
    while (true) {
      changed = paint(y * side + x, selectedColor, false) || changed;
      if (x === endX && y === endY) break;
      const twiceError = 2 * error;
      if (twiceError >= deltaY) { error += deltaY; x += stepX; }
      if (twiceError <= deltaX) { error += deltaX; y += stepY; }
    }
    if (changed) notifyChange();
  }

  function focusCell(index) {
    cells[focusIndex].tabIndex = -1;
    focusIndex = Math.max(0, Math.min(pixelCount - 1, index));
    cells[focusIndex].tabIndex = 0;
    cells[focusIndex].focus({ preventScroll: true });
  }

  function setColor(color) {
    if (!/^[0-9a-f]$/.test(color)) return;
    selectedColor = color;
    for (const button of paletteButtons) {
      const selected = button.dataset.pixelColor === color;
      button.setAttribute('aria-pressed', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
  }

  function finishStroke(event) {
    if (stroke && event.pointerId === stroke.pointerId) stroke = null;
  }

  function cellAtPoint(event) {
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-pixel-index]');
    return cell && grid.contains(cell) ? Number(cell.dataset.pixelIndex) : null;
  }

  grid.addEventListener('pointerdown', event => {
    if (!enabled() || event.button !== 0 || stroke) return;
    const cell = event.target.closest('[data-pixel-index]');
    if (!cell || !grid.contains(cell)) return;
    event.preventDefault();
    stroke = { pointerId: event.pointerId, changed: false, lastIndex: Number(cell.dataset.pixelIndex) };
    grid.setPointerCapture(event.pointerId);
    focusCell(Number(cell.dataset.pixelIndex));
    paint(focusIndex);
  });
  grid.addEventListener('pointermove', event => {
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    const index = cellAtPoint(event);
    if (index !== null) paintLine(stroke.lastIndex ?? index, index);
    stroke.lastIndex = index;
  });
  for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    grid.addEventListener(eventName, finishStroke);
  }
  grid.addEventListener('focusin', event => {
    const index = Number(event.target.dataset.pixelIndex);
    if (!Number.isInteger(index) || index < 0 || index >= pixelCount) return;
    cells[focusIndex].tabIndex = -1;
    focusIndex = index;
    cells[focusIndex].tabIndex = 0;
  });
  grid.addEventListener('keydown', event => {
    if (!enabled()) return;
    const row = Math.floor(focusIndex / side);
    const column = focusIndex % side;
    let nextIndex;
    if (event.key === 'ArrowLeft') nextIndex = row * side + Math.max(0, column - 1);
    else if (event.key === 'ArrowRight') nextIndex = row * side + Math.min(side - 1, column + 1);
    else if (event.key === 'ArrowUp') nextIndex = Math.max(0, row - 1) * side + column;
    else if (event.key === 'ArrowDown') nextIndex = Math.min(side - 1, row + 1) * side + column;
    else if (event.key === 'Home') nextIndex = event.ctrlKey || event.metaKey ? 0 : row * side;
    else if (event.key === 'End') nextIndex = event.ctrlKey || event.metaKey ? pixelCount - 1 : row * side + side - 1;
    else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      paint(focusIndex);
      return;
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      paint(focusIndex, '0');
      return;
    }
    if (nextIndex === undefined) return;
    event.preventDefault();
    focusCell(nextIndex);
    if (event.shiftKey) paint(nextIndex);
  });

  for (const button of paletteButtons) {
    button.addEventListener('click', () => {
      if (enabled()) setColor(button.dataset.pixelColor);
    });
    button.addEventListener('keydown', event => {
      if (!enabled()) return;
      const current = Number.parseInt(button.dataset.pixelColor, 16);
      const columns = getComputedStyle(button.parentElement).gridTemplateColumns.split(/\s+/).length;
      let next;
      if (event.key === 'ArrowLeft') next = (current + side - 1) % side;
      else if (event.key === 'ArrowRight') next = (current + 1) % side;
      else if (event.key === 'ArrowUp') next = (current + side - columns) % side;
      else if (event.key === 'ArrowDown') next = (current + columns) % side;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = side - 1;
      if (next === undefined) return;
      event.preventDefault();
      setColor(next.toString(16));
      paletteButtons[next].focus();
    });
  }

  function undo() {
    if (!enabled() || history.length === 0) return;
    stroke = null;
    pixels = history.pop();
    notifyChange();
  }
  undoButton.addEventListener('click', undo);
  clearButton.addEventListener('click', () => {
    if (!enabled() || pixels === blankPixels) return;
    stroke = null;
    remember();
    pixels = blankPixels;
    notifyChange();
  });
  editor.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undo();
    }
  });
  const ownerForm = input.form;
  function syncMode() {
    const choices = ownerForm?.querySelectorAll('input[type="radio"][name="avatarPreset"]');
    if (!choices?.length) return;
    const active = [...choices].some(choice => choice.checked && choice.value === 'pixel');
    editor.hidden = !active;
    input.disabled = !active;
    for (const button of [...cells, ...paletteButtons]) button.disabled = !active;
    if (!active) stroke = null;
    update();
  }
  ownerForm?.addEventListener('change', event => {
    if (event.target.name === 'avatarPreset') syncMode();
  });
  ownerForm?.addEventListener('reset', () => {
    queueMicrotask(() => {
      pixels = initialPixels;
      history.length = 0;
      stroke = null;
      setColor('3');
      syncMode();
      update();
    });
  });
  setColor('3');
  update();
  syncMode();
}

for (const editor of document.querySelectorAll('[data-avatar-editor]')) initializeEditor(editor);
