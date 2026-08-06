async function refresh() {
  try {
    const s = await browser.runtime.sendMessage("status");
    document.getElementById("conn").textContent = s.connected ? "Connected" : "Waiting for bridge";
    document.getElementById("dot").className = "dot" + (s.connected ? " on" : "");
    document.getElementById("bridge").textContent = s.bridge.replace("http://", "");
    document.getElementById("last").textContent = s.lastAction || "-";
    document.getElementById("count").textContent = s.doneCount;
    document.getElementById("err").textContent = s.lastError || "-";
  } catch (e) {
    document.getElementById("conn").textContent = "background not ready";
  }
}
refresh();
setInterval(refresh, 800);
