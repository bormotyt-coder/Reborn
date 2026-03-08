// data.js — exists for compatibility only.
// All state is managed by app.js using localStorage keys prefixed 'rb5_'.
// This file must NOT define a competing 'state' object or 'saveState' that
// touches meals/water/whoop — doing so caused the "adds but doesn't show" bug.
function saveState(){ /* intentional no-op */ }
