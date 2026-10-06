import { fileURLToPath } from "node:url";

/** Absolute path of the static files served at /ui/. */
export const APPROVAL_UI_DIR = fileURLToPath(new URL("./public/", import.meta.url));
