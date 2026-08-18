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

async function refreshPro() {
  try {
    const s = await browser.runtime.sendMessage({ cmd: "getPro" });
    const b = document.getElementById("protoggle");
    if (s && s.proOn) { b.textContent = "ON";  b.style.background = "#3c3"; b.style.color = "#031"; }
    else              { b.textContent = "OFF"; b.style.background = "#555"; b.style.color = "#fff"; }
  } catch (e) {}
}

document.getElementById("protoggle").addEventListener("click", async () => {
  try {
    const s = await browser.runtime.sendMessage({ cmd: "getPro" });
    await browser.runtime.sendMessage({ cmd: "setPro", on: !(s && s.proOn) });
    refreshPro();
  } catch (e) {}
});

refresh();
refreshPro();
setInterval(refresh, 800);
