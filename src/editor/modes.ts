// How a Markdown tab is shown. Pure.
//
// An editable file (fully read, valid UTF-8) offers Preview, Edit and Split.
// Anything else offers Preview and the read-only Source it always had, so a
// file that cannot be written back byte for byte never enters the editor.

export type MdMode = "preview" | "edit" | "split" | "source";
export type EditMode = "edit" | "split";

/** The mode to show, from what was chosen for this tab (if anything). A
 *  large document that cannot be edited opens in Source, as before 0.6.0;
 *  every other file opens in Preview until the user asks for the editor. */
export function resolveMode(chosen: MdMode | undefined, editable: boolean, big: boolean): MdMode {
  if (editable) return chosen === "edit" || chosen === "split" ? chosen : "preview";
  if (chosen === undefined) return big ? "source" : "preview";
  return chosen === "preview" ? "preview" : "source";
}

/** Ctrl+E: Preview to the last editing mode and back. Source counts as the
 *  editing side for a read-only file. */
export function toggledMode(current: MdMode, editable: boolean, lastEdit: EditMode): MdMode {
  if (current !== "preview") return "preview";
  return editable ? lastEdit : "source";
}

export function isEditing(mode: MdMode): mode is EditMode {
  return mode === "edit" || mode === "split";
}
