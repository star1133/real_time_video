(() => {
  const form = document.getElementById('join-form');
  const input = document.getElementById('room-code');
  const message = document.getElementById('join-message');
  if (new URLSearchParams(location.search).get('room') === 'unavailable') {
    message.textContent = 'เข้าห้องไม่ได้ ห้องอาจปิดแล้ว ขอรหัสใหม่จากเพื่อนหรือสร้างห้องใหม่ได้เลย';
  }

  input.addEventListener('input', () => {
    input.value = input.value.replace(/[^0-9]/g, '').slice(0, 3);
    input.setCustomValidity('');
    message.textContent = '';
  });
  input.addEventListener('invalid', () => {
    input.setCustomValidity('กรอกรหัสห้องเป็นตัวเลข 3 หลัก เช่น 123');
    message.textContent = 'กรอกรหัสตัวเลขให้ครบ 3 หลัก';
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = input.value.trim();
    if (/^\d{3}$/.test(code)) {
      form.querySelector('button').textContent = 'กำลังเข้าห้อง…';
      location.href = `/room/${code}`;
    }
  });
})();
