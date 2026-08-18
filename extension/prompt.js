async function showCur() {
  try {
    const s = await browser.runtime.sendMessage({ cmd: "getPro" });
    document.getElementById("cur").textContent =
      "Right now Pro is " + (s && s.proOn ? "ON" : "OFF") +
      ". You can change it anytime from the toolbar icon — no restart.";
  } catch (e) {}
}

async function answer(on) {
  document.getElementById("btns").innerHTML =
    '<div class="done">Saved — Pro ' + (on ? "ON" : "OFF") + ". Closing Firefox…</div>";
  try { await browser.runtime.sendMessage({ cmd: "answerPro", on }); } catch (e) {}
}

document.getElementById("yes").addEventListener("click", () => answer(true));
document.getElementById("no").addEventListener("click", () => answer(false));
showCur();
