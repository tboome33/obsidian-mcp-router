/**
 * What OBSIDIAN'S OWN parser made of every document in the shape grid.
 *
 * MEASURED, not declared. Each of the 225 documents `generateShapeCases()`
 * produces was written to a scratch folder of the `.template` vault, read back
 * through Local REST API's `application/vnd.olrapi.note+json` view, and the
 * page deleted. The values below are the `valid_from` / `valid_through` entries
 * Obsidian returned, verbatim — `undefined` (key absent from the object) and
 * `null` (key present and null) are different facts and both are preserved.
 *
 * WHY OBSIDIAN AND NOT A YAML LIBRARY. The invariant this lot defends is that
 * the router agrees with what the reader of a page SEES, and that is Obsidian's
 * parse. The two are not interchangeable: Obsidian hands back a bare ISO date
 * as a plain string where a YAML 1.1 loader hands back a Date, which
 * `classifyValidity` would judge `not-a-string` and report unreadable. An
 * oracle that disagrees with the consumer manufactures findings.
 *
 * HOW TO RE-CAPTURE. Write the grid into a scratch folder of any vault and read
 * each page back with the note+json Accept header. Run a POSITIVE CONTROL
 * first — a page with an obviously valid window — because an empty
 * `frontmatter` means either "the parse failed" or "Obsidian has not indexed
 * this yet", and only a control that moves tells them apart. Settle every read
 * against the CONTENT the response carries, so a stale index entry cannot be
 * mistaken for a verdict. Delete the pages in a `finally`.
 *
 * THIS FILE IS GENERATED. Re-capture it rather than editing a value by hand: a
 * hand-edited oracle is a declaration wearing a measurement's clothes, which is
 * the exact confusion the whole grid exists to remove.
 */

/** The day the capture ran, so a stale fixture is visible rather than assumed. */
export const SHAPE_ORACLE_CAPTURED_ON = '2026-09-19';

/** @type {Record<string, {valid_from?: unknown, valid_through?: unknown}>} */
export const SHAPE_ORACLE = {
  "k.double-quoted__v.block-map": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "k.double-quoted__v.block-scalar": {
    "valid_from": "2026-01-01\n"
  },
  "k.double-quoted__v.block-scalar-anchor": {
    "valid_from": "2026-01-01\n"
  },
  "k.double-quoted__v.block-scalar-comment": {
    "valid_from": "2026-01-01\n"
  },
  "k.double-quoted__v.comment-after": {
    "valid_from": "2026-01-01"
  },
  "k.double-quoted__v.comment-after-nbsp": {
    "valid_from": "2026-01-01 #note"
  },
  "k.double-quoted__v.date": {
    "valid_from": "2026-01-01"
  },
  "k.double-quoted__v.date-quoted": {
    "valid_from": "2026-01-01"
  },
  "k.double-quoted__v.empty": {
    "valid_from": null
  },
  "k.double-quoted__v.flow-map": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "k.double-quoted__v.folded-continuation": {
    "valid_from": "2026-01-01 suite"
  },
  "k.double-quoted__v.list-column-zero": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "k.double-quoted__v.list-indented": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "k.double-quoted__v.not-a-date": {
    "valid_from": "2026-13-45"
  },
  "k.double-quoted__v.null": {
    "valid_from": null
  },
  "k.escaped__v.block-map": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "k.escaped__v.block-scalar": {
    "valid_from": "2026-01-01\n"
  },
  "k.escaped__v.block-scalar-anchor": {
    "valid_from": "2026-01-01\n"
  },
  "k.escaped__v.block-scalar-comment": {
    "valid_from": "2026-01-01\n"
  },
  "k.escaped__v.comment-after": {
    "valid_from": "2026-01-01"
  },
  "k.escaped__v.comment-after-nbsp": {
    "valid_from": "2026-01-01 #note"
  },
  "k.escaped__v.date": {
    "valid_from": "2026-01-01"
  },
  "k.escaped__v.date-quoted": {
    "valid_from": "2026-01-01"
  },
  "k.escaped__v.empty": {
    "valid_from": null
  },
  "k.escaped__v.flow-map": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "k.escaped__v.folded-continuation": {
    "valid_from": "2026-01-01 suite"
  },
  "k.escaped__v.list-column-zero": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "k.escaped__v.list-indented": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "k.escaped__v.not-a-date": {
    "valid_from": "2026-13-45"
  },
  "k.escaped__v.null": {
    "valid_from": null
  },
  "k.explicit__v.block-map": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "k.explicit__v.block-scalar": {
    "valid_from": "2026-01-01\n"
  },
  "k.explicit__v.block-scalar-anchor": {
    "valid_from": "2026-01-01\n"
  },
  "k.explicit__v.block-scalar-comment": {
    "valid_from": "2026-01-01\n"
  },
  "k.explicit__v.comment-after": {
    "valid_from": "2026-01-01"
  },
  "k.explicit__v.comment-after-nbsp": {
    "valid_from": "2026-01-01 #note"
  },
  "k.explicit__v.date": {
    "valid_from": "2026-01-01"
  },
  "k.explicit__v.date-quoted": {
    "valid_from": "2026-01-01"
  },
  "k.explicit__v.empty": {
    "valid_from": null
  },
  "k.explicit__v.flow-map": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "k.explicit__v.folded-continuation": {
    "valid_from": "2026-01-01 suite"
  },
  "k.explicit__v.list-column-zero": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "k.explicit__v.list-indented": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "k.explicit__v.not-a-date": {
    "valid_from": "2026-13-45"
  },
  "k.explicit__v.null": {
    "valid_from": null
  },
  "k.indented__v.block-map": {
    "valid_from": null
  },
  "k.indented__v.block-scalar": {},
  "k.indented__v.block-scalar-anchor": {},
  "k.indented__v.block-scalar-comment": {},
  "k.indented__v.comment-after": {
    "valid_from": "2026-01-01"
  },
  "k.indented__v.comment-after-nbsp": {
    "valid_from": "2026-01-01 #note"
  },
  "k.indented__v.date": {
    "valid_from": "2026-01-01"
  },
  "k.indented__v.date-quoted": {
    "valid_from": "2026-01-01"
  },
  "k.indented__v.empty": {
    "valid_from": null
  },
  "k.indented__v.flow-map": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "k.indented__v.folded-continuation": {},
  "k.indented__v.list-column-zero": {},
  "k.indented__v.list-indented": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "k.indented__v.not-a-date": {
    "valid_from": "2026-13-45"
  },
  "k.indented__v.null": {
    "valid_from": null
  },
  "k.plain__v.block-map": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "k.plain__v.block-scalar": {
    "valid_from": "2026-01-01\n"
  },
  "k.plain__v.block-scalar-anchor": {
    "valid_from": "2026-01-01\n"
  },
  "k.plain__v.block-scalar-comment": {
    "valid_from": "2026-01-01\n"
  },
  "k.plain__v.comment-after": {
    "valid_from": "2026-01-01"
  },
  "k.plain__v.comment-after-nbsp": {
    "valid_from": "2026-01-01 #note"
  },
  "k.plain__v.date": {
    "valid_from": "2026-01-01"
  },
  "k.plain__v.date-quoted": {
    "valid_from": "2026-01-01"
  },
  "k.plain__v.empty": {
    "valid_from": null
  },
  "k.plain__v.flow-map": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "k.plain__v.folded-continuation": {
    "valid_from": "2026-01-01 suite"
  },
  "k.plain__v.list-column-zero": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "k.plain__v.list-indented": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "k.plain__v.not-a-date": {
    "valid_from": "2026-13-45"
  },
  "k.plain__v.null": {
    "valid_from": null
  },
  "k.single-quoted__v.block-map": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "k.single-quoted__v.block-scalar": {
    "valid_from": "2026-01-01\n"
  },
  "k.single-quoted__v.block-scalar-anchor": {
    "valid_from": "2026-01-01\n"
  },
  "k.single-quoted__v.block-scalar-comment": {
    "valid_from": "2026-01-01\n"
  },
  "k.single-quoted__v.comment-after": {
    "valid_from": "2026-01-01"
  },
  "k.single-quoted__v.comment-after-nbsp": {
    "valid_from": "2026-01-01 #note"
  },
  "k.single-quoted__v.date": {
    "valid_from": "2026-01-01"
  },
  "k.single-quoted__v.date-quoted": {
    "valid_from": "2026-01-01"
  },
  "k.single-quoted__v.empty": {
    "valid_from": null
  },
  "k.single-quoted__v.flow-map": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "k.single-quoted__v.folded-continuation": {
    "valid_from": "2026-01-01 suite"
  },
  "k.single-quoted__v.list-column-zero": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "k.single-quoted__v.list-indented": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "k.single-quoted__v.not-a-date": {
    "valid_from": "2026-13-45"
  },
  "k.single-quoted__v.null": {
    "valid_from": null
  },
  "v.block-map__c.after-a-blank-line": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "v.block-map__c.after-a-block-scalar": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "v.block-map__c.after-a-column-zero-sequence": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "v.block-map__c.after-a-comment": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "v.block-map__c.after-a-key": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "v.block-map__c.after-a-nested-block": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "v.block-map__c.before-a-key": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "v.block-map__c.indented-document": {},
  "v.block-map__c.with-a-second-bound": {
    "valid_from": {
      "date": "2026-01-01"
    },
    "valid_through": "2026-12-31"
  },
  "v.block-scalar-anchor__c.after-a-blank-line": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar-anchor__c.after-a-block-scalar": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar-anchor__c.after-a-column-zero-sequence": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar-anchor__c.after-a-comment": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar-anchor__c.after-a-key": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar-anchor__c.after-a-nested-block": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar-anchor__c.before-a-key": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar-anchor__c.indented-document": {},
  "v.block-scalar-anchor__c.with-a-second-bound": {
    "valid_from": "2026-01-01\n",
    "valid_through": "2026-12-31"
  },
  "v.block-scalar-comment__c.after-a-blank-line": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar-comment__c.after-a-block-scalar": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar-comment__c.after-a-column-zero-sequence": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar-comment__c.after-a-comment": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar-comment__c.after-a-key": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar-comment__c.after-a-nested-block": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar-comment__c.before-a-key": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar-comment__c.indented-document": {},
  "v.block-scalar-comment__c.with-a-second-bound": {
    "valid_from": "2026-01-01\n",
    "valid_through": "2026-12-31"
  },
  "v.block-scalar__c.after-a-blank-line": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar__c.after-a-block-scalar": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar__c.after-a-column-zero-sequence": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar__c.after-a-comment": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar__c.after-a-key": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar__c.after-a-nested-block": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar__c.before-a-key": {
    "valid_from": "2026-01-01\n"
  },
  "v.block-scalar__c.indented-document": {},
  "v.block-scalar__c.with-a-second-bound": {
    "valid_from": "2026-01-01\n",
    "valid_through": "2026-12-31"
  },
  "v.comment-after-nbsp__c.after-a-blank-line": {
    "valid_from": "2026-01-01 #note"
  },
  "v.comment-after-nbsp__c.after-a-block-scalar": {
    "valid_from": "2026-01-01 #note"
  },
  "v.comment-after-nbsp__c.after-a-column-zero-sequence": {
    "valid_from": "2026-01-01 #note"
  },
  "v.comment-after-nbsp__c.after-a-comment": {
    "valid_from": "2026-01-01 #note"
  },
  "v.comment-after-nbsp__c.after-a-key": {
    "valid_from": "2026-01-01 #note"
  },
  "v.comment-after-nbsp__c.after-a-nested-block": {
    "valid_from": "2026-01-01 #note"
  },
  "v.comment-after-nbsp__c.before-a-key": {
    "valid_from": "2026-01-01 #note"
  },
  "v.comment-after-nbsp__c.indented-document": {},
  "v.comment-after-nbsp__c.with-a-second-bound": {
    "valid_from": "2026-01-01 #note",
    "valid_through": "2026-12-31"
  },
  "v.comment-after__c.after-a-blank-line": {
    "valid_from": "2026-01-01"
  },
  "v.comment-after__c.after-a-block-scalar": {
    "valid_from": "2026-01-01"
  },
  "v.comment-after__c.after-a-column-zero-sequence": {
    "valid_from": "2026-01-01"
  },
  "v.comment-after__c.after-a-comment": {
    "valid_from": "2026-01-01"
  },
  "v.comment-after__c.after-a-key": {
    "valid_from": "2026-01-01"
  },
  "v.comment-after__c.after-a-nested-block": {
    "valid_from": "2026-01-01"
  },
  "v.comment-after__c.before-a-key": {
    "valid_from": "2026-01-01"
  },
  "v.comment-after__c.indented-document": {},
  "v.comment-after__c.with-a-second-bound": {
    "valid_from": "2026-01-01",
    "valid_through": "2026-12-31"
  },
  "v.date-quoted__c.after-a-blank-line": {
    "valid_from": "2026-01-01"
  },
  "v.date-quoted__c.after-a-block-scalar": {
    "valid_from": "2026-01-01"
  },
  "v.date-quoted__c.after-a-column-zero-sequence": {
    "valid_from": "2026-01-01"
  },
  "v.date-quoted__c.after-a-comment": {
    "valid_from": "2026-01-01"
  },
  "v.date-quoted__c.after-a-key": {
    "valid_from": "2026-01-01"
  },
  "v.date-quoted__c.after-a-nested-block": {
    "valid_from": "2026-01-01"
  },
  "v.date-quoted__c.before-a-key": {
    "valid_from": "2026-01-01"
  },
  "v.date-quoted__c.indented-document": {},
  "v.date-quoted__c.with-a-second-bound": {
    "valid_from": "2026-01-01",
    "valid_through": "2026-12-31"
  },
  "v.date__c.after-a-blank-line": {
    "valid_from": "2026-01-01"
  },
  "v.date__c.after-a-block-scalar": {
    "valid_from": "2026-01-01"
  },
  "v.date__c.after-a-column-zero-sequence": {
    "valid_from": "2026-01-01"
  },
  "v.date__c.after-a-comment": {
    "valid_from": "2026-01-01"
  },
  "v.date__c.after-a-key": {
    "valid_from": "2026-01-01"
  },
  "v.date__c.after-a-nested-block": {
    "valid_from": "2026-01-01"
  },
  "v.date__c.before-a-key": {
    "valid_from": "2026-01-01"
  },
  "v.date__c.indented-document": {},
  "v.date__c.with-a-second-bound": {
    "valid_from": "2026-01-01",
    "valid_through": "2026-12-31"
  },
  "v.empty__c.after-a-blank-line": {
    "valid_from": null
  },
  "v.empty__c.after-a-block-scalar": {
    "valid_from": null
  },
  "v.empty__c.after-a-column-zero-sequence": {
    "valid_from": null
  },
  "v.empty__c.after-a-comment": {
    "valid_from": null
  },
  "v.empty__c.after-a-key": {
    "valid_from": null
  },
  "v.empty__c.after-a-nested-block": {
    "valid_from": null
  },
  "v.empty__c.before-a-key": {
    "valid_from": null
  },
  "v.empty__c.indented-document": {},
  "v.empty__c.with-a-second-bound": {
    "valid_from": null,
    "valid_through": "2026-12-31"
  },
  "v.flow-map__c.after-a-blank-line": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "v.flow-map__c.after-a-block-scalar": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "v.flow-map__c.after-a-column-zero-sequence": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "v.flow-map__c.after-a-comment": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "v.flow-map__c.after-a-key": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "v.flow-map__c.after-a-nested-block": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "v.flow-map__c.before-a-key": {
    "valid_from": {
      "date": "2026-01-01"
    }
  },
  "v.flow-map__c.indented-document": {},
  "v.flow-map__c.with-a-second-bound": {
    "valid_from": {
      "date": "2026-01-01"
    },
    "valid_through": "2026-12-31"
  },
  "v.folded-continuation__c.after-a-blank-line": {
    "valid_from": "2026-01-01 suite"
  },
  "v.folded-continuation__c.after-a-block-scalar": {
    "valid_from": "2026-01-01 suite"
  },
  "v.folded-continuation__c.after-a-column-zero-sequence": {
    "valid_from": "2026-01-01 suite"
  },
  "v.folded-continuation__c.after-a-comment": {
    "valid_from": "2026-01-01 suite"
  },
  "v.folded-continuation__c.after-a-key": {
    "valid_from": "2026-01-01 suite"
  },
  "v.folded-continuation__c.after-a-nested-block": {
    "valid_from": "2026-01-01 suite"
  },
  "v.folded-continuation__c.before-a-key": {
    "valid_from": "2026-01-01 suite"
  },
  "v.folded-continuation__c.indented-document": {},
  "v.folded-continuation__c.with-a-second-bound": {
    "valid_from": "2026-01-01 suite",
    "valid_through": "2026-12-31"
  },
  "v.list-column-zero__c.after-a-blank-line": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "v.list-column-zero__c.after-a-block-scalar": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "v.list-column-zero__c.after-a-column-zero-sequence": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "v.list-column-zero__c.after-a-comment": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "v.list-column-zero__c.after-a-key": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "v.list-column-zero__c.after-a-nested-block": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "v.list-column-zero__c.before-a-key": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "v.list-column-zero__c.indented-document": {},
  "v.list-column-zero__c.with-a-second-bound": {
    "valid_from": [
      "2026-01-01"
    ],
    "valid_through": "2026-12-31"
  },
  "v.list-indented__c.after-a-blank-line": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "v.list-indented__c.after-a-block-scalar": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "v.list-indented__c.after-a-column-zero-sequence": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "v.list-indented__c.after-a-comment": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "v.list-indented__c.after-a-key": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "v.list-indented__c.after-a-nested-block": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "v.list-indented__c.before-a-key": {
    "valid_from": [
      "2026-01-01"
    ]
  },
  "v.list-indented__c.indented-document": {},
  "v.list-indented__c.with-a-second-bound": {
    "valid_from": [
      "2026-01-01"
    ],
    "valid_through": "2026-12-31"
  },
  "v.not-a-date__c.after-a-blank-line": {
    "valid_from": "2026-13-45"
  },
  "v.not-a-date__c.after-a-block-scalar": {
    "valid_from": "2026-13-45"
  },
  "v.not-a-date__c.after-a-column-zero-sequence": {
    "valid_from": "2026-13-45"
  },
  "v.not-a-date__c.after-a-comment": {
    "valid_from": "2026-13-45"
  },
  "v.not-a-date__c.after-a-key": {
    "valid_from": "2026-13-45"
  },
  "v.not-a-date__c.after-a-nested-block": {
    "valid_from": "2026-13-45"
  },
  "v.not-a-date__c.before-a-key": {
    "valid_from": "2026-13-45"
  },
  "v.not-a-date__c.indented-document": {},
  "v.not-a-date__c.with-a-second-bound": {
    "valid_from": "2026-13-45",
    "valid_through": "2026-12-31"
  },
  "v.null__c.after-a-blank-line": {
    "valid_from": null
  },
  "v.null__c.after-a-block-scalar": {
    "valid_from": null
  },
  "v.null__c.after-a-column-zero-sequence": {
    "valid_from": null
  },
  "v.null__c.after-a-comment": {
    "valid_from": null
  },
  "v.null__c.after-a-key": {
    "valid_from": null
  },
  "v.null__c.after-a-nested-block": {
    "valid_from": null
  },
  "v.null__c.before-a-key": {
    "valid_from": null
  },
  "v.null__c.indented-document": {},
  "v.null__c.with-a-second-bound": {
    "valid_from": null,
    "valid_through": "2026-12-31"
  }
};
