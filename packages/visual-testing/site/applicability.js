// Provider applicability for the site home. A case's matrix row declares the
// providers it owes a capture for (react-only cases list just react); an
// undeclared provider is n/a for that case, not missing.
// Classic script: inlined ahead of home.js in the generated index.html, and run
// in a vm context by tests/siteApplicability.test.ts.
var VtApplicability = (function () {
  // Cases without declaredProviders (older runs) keep the plain reading.
  function providerDeclared(item, provider) {
    return !item || !item.declaredProviders || item.declaredProviders.indexOf(provider) !== -1;
  }
  function providerCaptured(item, provider) {
    var entry = item && item.providers && item.providers[provider];
    return Boolean(entry && entry.status === "captured");
  }
  // A missing pair is n/a only when every end without a capture is one the
  // case does not declare. A declared end that lost its capture keeps the
  // pair missing, so a broken capture is never hidden as n/a.
  function pairNotApplicable(item, entry) {
    if (!item || !item.declaredProviders || !entry || entry.status !== "missing") return false;
    var missingEnds = [entry.leftProvider, entry.rightProvider].filter(function (provider) {
      return !providerCaptured(item, provider);
    });
    return missingEnds.length > 0 && missingEnds.every(function (provider) {
      return !providerDeclared(item, provider);
    });
  }
  // Rewrites "missing" to "n/a" in place on the embedded case payload.
  function markNotApplicable(cases) {
    (cases || []).forEach(function (item) {
      if (!item || !item.declaredProviders) return;
      Object.keys(item.pairs || {}).forEach(function (key) {
        var entry = item.pairs[key];
        if (pairNotApplicable(item, entry)) entry.status = "n/a";
      });
      Object.keys(item.providers || {}).forEach(function (provider) {
        var entry = item.providers[provider];
        if (entry && entry.status === "missing" && !providerDeclared(item, provider)) entry.status = "n/a";
      });
    });
  }
  return {
    providerDeclared: providerDeclared,
    pairNotApplicable: pairNotApplicable,
    markNotApplicable: markNotApplicable
  };
})();
