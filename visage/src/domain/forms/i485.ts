import fieldDump from '../../../assets/forms/i-485/2025-01-20/fields.json' with { type: 'json' };
import { alienNumber, upper, usDate, type FormMapping } from './types';

const F = (leaf: string, sub = 0) => `form1[0].#subform[${sub}].${leaf}`;

/**
 * Form I-485, edition 01/20/25.
 *
 * Every `pdf` name here was taken from assets/forms/i-485/2025-01-20/fields.json,
 * never from memory. The form is not internally consistent — Part 1 fields are
 * `Pt1Line...`, Part 4 fields are `P4Line...`, and the Part 14 continuation
 * slots are named `Pt9Line3a/3b/3c` despite belonging to Part 14 — so guessing
 * a name is guaranteed to be wrong eventually.
 */
export const I485_MAPPING: FormMapping = {
  formCode: 'I-485',
  edition: '01/20/25',
  assetDir: 'assets/forms/i-485/2025-01-20',

  text: [
    { pdf: F('Pt1Line1_FamilyName[0]'), path: 'applicant.name.family', transform: upper },
    { pdf: F('Pt1Line1_GivenName[0]'), path: 'applicant.name.given', transform: upper },
    { pdf: F('Pt1Line1_MiddleName[0]'), path: 'applicant.name.middle', transform: upper },
    { pdf: F('Pt1Line3_DOB[0]'), path: 'applicant.dateOfBirth', transform: usDate },
    { pdf: F('Pt1Line7_CityTownOfBirth[0]', 1), path: 'applicant.cityOfBirth' },
    { pdf: F('Pt1Line7_CountryOfBirth[0]', 1), path: 'applicant.countryOfBirth' },
    { pdf: F('Pt1Line8_CountryofCitizenshipNationality[0]', 1), path: 'applicant.countryOfCitizenship' },
    { pdf: F('Pt1Line4_AlienNumber[0]', 1), path: 'applicant.alienNumber', transform: alienNumber },
    { pdf: F('Pt1Line10_PassportNum[0]', 1), path: 'applicant.passport.number' },
    { pdf: F('Pt1Line10_DateofArrival[0]', 1), path: 'applicant.lastArrival.date', transform: usDate },
  ],

  // Export values are opaque strings ("11A", "3a0", "Y") that exist nowhere but
  // the form itself.
  checkboxes: [],

  dropdowns: [
    { pdf: F('Pt7Line3_HeightFeet[0]', 12), path: 'applicant.height.feet' },
    { pdf: F('Pt7Line3_HeightInches[0]', 12), path: 'applicant.height.inches' },
  ],

  // The A-Number is not a single field: it repeats in the header of all 24
  // pages, and filling only the first leaves the rest looking blank. Read from
  // the dump because the names are not derivable — subform indices skip 19,
  // so the last five pages do not follow the pattern the first nineteen do.
  pageHeader: {
    fields: fieldDump
      .filter((f) => f.type === 'text' && /\.AlienNumber\[\d+\]$/.test(f.name))
      .map((f) => f.name),
    path: 'applicant.alienNumber',
    transform: alienNumber,
  },

  overflow: {
    slots: [
      { text: F('P14_Line2_AdditionalInfo[0]', 24), page: F('Pt9Line3a_PageNumber[0]', 24),
        part: F('Pt9Line3b_PartNumber[0]', 24), item: F('Pt9Line3c_ItemNumber[0]', 24) },
      { text: F('P14_Line3_AdditionalInfo[0]', 24), page: F('Pt9Line3a_PageNumber[1]', 24),
        part: F('Pt9Line3b_PartNumber[1]', 24), item: F('Pt9Line3c_ItemNumber[1]', 24) },
      { text: F('P14_Line4_AdditionalInfo[0]', 24), page: F('Pt9Line3a_PageNumber[2]', 24),
        part: F('Pt9Line3b_PartNumber[2]', 24), item: F('Pt9Line3c_ItemNumber[2]', 24) },
      { text: F('P14_Line5_AdditionalInfo[0]', 24), page: F('Pt9Line3a_PageNumber[3]', 24),
        part: F('Pt9Line3b_PartNumber[3]', 24), item: F('Pt9Line3c_ItemNumber[3]', 24) },
    ],
    identity: [
      { pdf: F('Pt1Line1_FamilyName[1]', 24), path: 'applicant.name.family', transform: upper },
      { pdf: F('Pt1Line1_GivenName[1]', 24), path: 'applicant.name.given', transform: upper },
      { pdf: F('Pt1Line1_MiddleName[1]', 24), path: 'applicant.name.middle', transform: upper },
    ],
  },
};
