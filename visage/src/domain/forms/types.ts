/** A flat canonical profile: dotted path -> value. */
export type Profile = Readonly<Record<string, string | null>>;

export interface FieldMapping {
  /** Fully-qualified AcroForm field name, taken from the committed field dump. */
  readonly pdf: string;
  readonly path: string;
  readonly transform?: (value: string) => string;
}

export interface CheckboxMapping {
  readonly pdf: string;
  readonly path: string;
  /** Tick when the profile value equals this. */
  readonly equals: string;
  /** The checkbox's export value — opaque, and only knowable from the dump. */
  readonly on: string;
}

export interface DropdownMapping {
  readonly pdf: string;
  readonly path: string;
  readonly transform?: (value: string) => string;
}

/** Content that did not fit its section and continues on the Part 14 sheet. */
export interface OverflowEntry {
  readonly partNumber: string;
  readonly itemNumber: string;
  readonly pageNumber: string;
  readonly text: string;
}

export interface FormMapping {
  readonly formCode: string;
  /** Asserted against the barcode read out of the PDF before filling. */
  readonly edition: string;
  readonly assetDir: string;
  readonly text: readonly FieldMapping[];
  readonly checkboxes: readonly CheckboxMapping[];
  readonly dropdowns: readonly DropdownMapping[];
  /**
   * Fields repeated in every page header, e.g. the A-Number. Held as an
   * explicit list read from the field dump rather than a constructed pattern:
   * the I-485's subform indices skip 19, so `#subform[i].AlienNumber[i]` is
   * correct for the first 19 pages and wrong for the last five.
   */
  readonly pageHeader?: { readonly fields: readonly string[]; readonly path: string;
                          readonly transform?: (v: string) => string };
  readonly overflow: {
    readonly slots: readonly {
      readonly text: string; readonly page: string; readonly part: string; readonly item: string;
    }[];
    /** Applicant name repeated on the continuation sheet. */
    readonly identity: readonly FieldMapping[];
  };
}

// ------------------------------------------------------------- transforms ---

export const upper = (v: string): string => v.toUpperCase();
export const digitsOnly = (v: string): string => v.replace(/\D/g, '');

/** ISO 8601 in the profile, MM/DD/YYYY on every USCIS form. */
export const usDate = (v: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  return m ? `${m[2]}/${m[3]}/${m[1]}` : v;
};

/** A-Numbers print without the leading "A" and without separators. */
export const alienNumber = (v: string): string => v.replace(/^A/i, '').replace(/\D/g, '');
