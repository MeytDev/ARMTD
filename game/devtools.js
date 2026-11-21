function getLocationSearch(){
  try {
    return typeof globalThis !== "undefined" && globalThis.location
      ? globalThis.location.search
      : "";
  } catch (_) {
    return "";
  }
}

/**
 * Development-only tools are opt-in and deliberately not persisted.
 * The exact `?devtools=1` flag keeps release sessions free of test controls
 * while still allowing a developer to open them on a local build.
 */
export function isDevToolsEnabled(search = getLocationSearch()){
  try {
    return new URLSearchParams(String(search || "")).get("devtools") === "1";
  } catch (_) {
    return false;
  }
}
