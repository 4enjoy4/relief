/* ================= boot ================= */

let savedTheme = null, savedTopic = null;
try {
  savedTheme = localStorage.getItem('wb.theme');
  savedTopic = localStorage.getItem('wb.topic');
} catch (e) {}
applyTheme(['dark', 'darcula', 'midnight'].includes(savedTheme) ? savedTheme : 'dark');
loadTopic(TOPICS[savedTopic] ? savedTopic : 'webapp');
if (!TOPICS[savedTopic]) {
  renderCards();
  welcomeEl.classList.add('show');
}
updateBugUI();
termLoop();
toastLoop();
bugLoop();
