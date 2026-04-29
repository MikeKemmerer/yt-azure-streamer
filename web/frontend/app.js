async function loadInfo() {
  try {
    const res = await fetch('/api/info');
    const data = await res.json();
    document.getElementById('info').textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    document.getElementById('info').textContent = "Error loading info";
  }
}

loadInfo();
