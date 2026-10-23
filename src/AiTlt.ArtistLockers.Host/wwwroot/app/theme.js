// Applies the saved theme before first paint (classic script, loaded in <head>). "system" leaves [data-theme] unset.
(function () {
  try {
    var theme = localStorage.getItem("ait-theme");
    if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
  } catch (e) { /* storage blocked: follow the system */ }
})();
