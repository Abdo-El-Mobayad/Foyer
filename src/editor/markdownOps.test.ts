import { describe, expect, it } from "vitest";
import {
  isoDate,
  isoDateTime,
  leadFor,
  leadOf,
  nextNumber,
  rankCommands,
  SLASH_COMMANDS,
  slashCut,
  taskBox,
  type BlockKind,
} from "./markdownOps";

/** A line turned into `kind` the way the editor does it: the lead swapped,
 *  the rest untouched. */
const turn = (line: string, kind: BlockKind, n = 1) => {
  const lead = leadOf(line);
  return leadFor(kind, lead, n) + line.slice(lead.length);
};

describe("line leads", () => {
  it("recognizes every block marker", () => {
    const cases: Array<[string, BlockKind, string]> = [
      ["plain text", "text", ""],
      ["# Title", "h1", "# "],
      ["### Deep", "h3", "### "],
      ["###### Six", "h6", "###### "],
      ["> quoted", "quote", "> "],
      [">tight", "quote", ">"],
      ["- item", "bullet", "- "],
      ["* item", "bullet", "* "],
      ["12. item", "numbered", "12. "],
      ["3) item", "numbered", "3) "],
      ["- [ ] todo", "task", "- [ ] "],
      ["- [x] done", "task", "- [x] "],
      ["- [ ]", "task", "- [ ]"],
    ];
    for (const [line, kind, marker] of cases) {
      const lead = leadOf(line);
      expect([lead.kind, lead.marker], line).toEqual([kind, marker]);
    }
  });

  it("does not mistake text for a marker", () => {
    for (const line of ["#hashtag", "-dash", "1.5 litres", "[x] not a task", "---"]) {
      expect(leadOf(line).kind, line).toBe("text");
    }
  });

  it("keeps indentation separate", () => {
    expect(leadOf("    - nested")).toMatchObject({ indent: "    ", marker: "- ", length: 6 });
  });
});

describe("turning a line into a block", () => {
  it("keeps the text and swaps only the marker", () => {
    expect(turn("buy milk", "task")).toBe("- [ ] buy milk");
    expect(turn("- [x] buy milk", "bullet")).toBe("- buy milk");
    expect(turn("## Plan", "h1")).toBe("# Plan");
    expect(turn("> said", "text")).toBe("said");
    expect(turn("- item", "numbered", 4)).toBe("4. item");
    expect(turn("", "h2")).toBe("## ");
  });

  it("keeps list nesting but puts headings and quotes at the margin", () => {
    expect(turn("    - nested", "task")).toBe("    - [ ] nested");
    expect(turn("    - nested", "h2")).toBe("## nested");
    expect(turn("  text", "quote")).toBe("> text");
  });

  it("continues a numbered list", () => {
    expect(nextNumber("3. three", "")).toBe(4);
    expect(nextNumber("  3. nested", "")).toBe(1);
    expect(nextNumber("  3. nested", "  ")).toBe(4);
    expect(nextNumber("- bullet", "")).toBe(1);
    expect(nextNumber(null, "")).toBe(1);
  });
});

describe("checkboxes", () => {
  it("finds the box and what a toggle writes", () => {
    expect(taskBox("- [ ] a")).toEqual({ offset: 3, next: "x" });
    expect(taskBox("  * [X] b")).toEqual({ offset: 5, next: " " });
    expect(taskBox("- a")).toBeNull();
  });
});

describe("slash command removal", () => {
  it("takes the space that introduced a trailing command", () => {
    const line = "milk /todo";
    expect(slashCut(line, 5, 10, 0)).toBe(4);
  });

  it("keeps the space when text follows the command", () => {
    const line = "a /b c";
    expect(slashCut(line, 2, 4, 0)).toBe(1);
    expect(slashCut("a /bc", 2, 5, 0)).toBe(1);
    expect(slashCut("a /bcd", 2, 4, 0)).toBe(2);
  });

  it("never eats into the line's marker", () => {
    expect(slashCut("- /todo", 2, 7, 2)).toBe(2);
    expect(slashCut("/h1", 0, 3, 0)).toBe(0);
  });
});

describe("dates", () => {
  it("writes local ISO dates", () => {
    const d = new Date(2026, 0, 5, 9, 7);
    expect(isoDate(d)).toBe("2026-01-05");
    expect(isoDateTime(d)).toBe("2026-01-05 09:07");
  });
});

describe("the slash menu", () => {
  const ids = (q: string) => rankCommands(q).map((c) => c.id);

  it("lists everything, in catalog order, before anything is typed", () => {
    expect(ids("")).toEqual(SLASH_COMMANDS.map((c) => c.id));
  });

  it("finds commands by name, word and alias", () => {
    expect(ids("todo")[0]).toBe("task");
    expect(ids("che")[0]).toBe("task");
    expect(ids("h2")[0]).toBe("h2");
    expect(ids("heading2")[0]).toBe("h2");
    expect(ids("hr")[0]).toBe("divider");
    expect(ids("tab")[0]).toBe("table");
    expect(ids("date")[0]).toBe("today");
    expect(ids("b")[0]).toBe("bold");
    expect(ids("list")).toEqual(expect.arrayContaining(["bullet", "numbered"]));
  });

  it("ranks an exact alias above a prefix", () => {
    // "code" is Inline code's alias and a word of Code block's name.
    expect(ids("code").slice(0, 2)).toEqual(["code", "codeblock"]);
  });

  it("returns nothing for nonsense", () => {
    expect(ids("zzzq")).toEqual([]);
  });

  it("leaves a blank line after a table, so the next line is not a row", () => {
    const table = SLASH_COMMANDS.find((c) => c.id === "table")!.action;
    expect(table.type === "lines" && table.snippet.endsWith("|\n\n${}")).toBe(true);
  });

  it("gives every command a unique id and label", () => {
    const labels = SLASH_COMMANDS.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(SLASH_COMMANDS.map((c) => c.id)).size).toBe(labels.length);
  });
});
