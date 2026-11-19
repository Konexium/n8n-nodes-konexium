const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normaliseCountry } = require('../dist/nodes/Konexium/country.js');
const context = { getNode: () => ({ name: 'Konexium', typeVersion: 1 }) };

// Independent coverage of every supported country's English name and ISO codes.
const countries = `
DZ DZA Algeria
AO AGO Angola
BJ BEN Benin
BW BWA Botswana
BF BFA Burkina Faso
BI BDI Burundi
CV CPV Cabo Verde
CM CMR Cameroon
CF CAF Central African Republic
TD TCD Chad
KM COM Comoros
CG COG Republic of the Congo
CD COD Democratic Republic of the Congo
CI CIV Ivory Coast
DJ DJI Djibouti
EG EGY Egypt
GQ GNQ Equatorial Guinea
ER ERI Eritrea
SZ SWZ Eswatini
ET ETH Ethiopia
GA GAB Gabon
GM GMB Gambia
GH GHA Ghana
GN GIN Guinea
GW GNB Guinea-Bissau
KE KEN Kenya
LS LSO Lesotho
LR LBR Liberia
LY LBY Libya
MG MDG Madagascar
MW MWI Malawi
ML MLI Mali
MR MRT Mauritania
MU MUS Mauritius
MA MAR Morocco
MZ MOZ Mozambique
NA NAM Namibia
NE NER Niger
NG NGA Nigeria
RW RWA Rwanda
ST STP Sao Tome and Principe
SN SEN Senegal
SC SYC Seychelles
SL SLE Sierra Leone
SO SOM Somalia
ZA ZAF South Africa
SS SSD South Sudan
SD SDN Sudan
TZ TZA Tanzania
TG TGO Togo
TN TUN Tunisia
UG UGA Uganda
ZM ZMB Zambia
ZW ZWE Zimbabwe
`.trim().split('\n').map((line) => [line.slice(0, 2), line.slice(3, 6), line.slice(7)]);

test('all 54 African names, alpha-2 and alpha-3 codes resolve, trimmed and case insensitive', () => {
  assert.equal(countries.length, 54);
  assert.equal(new Set(countries.map(([code]) => code)).size, 54);
  for (const [alpha2, alpha3, name] of countries) {
    for (const input of [alpha2, alpha3, name]) {
      for (const value of [input, ` \t${input.toLowerCase()}\n`, input.toUpperCase()]) {
        assert.equal(normaliseCountry(context, value), alpha2, value);
      }
    }
  }
});

test('every two-letter ASCII code retains the existing passthrough behaviour', () => {
  // Includes non-African and unassigned codes: the API still decides support.
  for (const first of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    for (const second of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const code = first + second;
      assert.equal(normaliseCountry(context, ` ${code.toLowerCase()} `), code);
    }
  }
});

test('accents, decomposed Unicode, punctuation and common variants resolve exactly', () => {
  const variants = [
    ["Côte d'Ivoire", 'CI'],
    ['CÔTE D’IVOIRE', 'CI'],
    ["Co\u0302te d'Ivoire", 'CI'],
    ['Ivory Coast', 'CI'],
    ['DRC', 'CD'],
    ['DR Congo', 'CD'],
    ['Congo-Kinshasa', 'CD'],
    ['Democratic Republic of the Congo', 'CD'],
    ['Democratic Republic of Congo', 'CD'],
    ['Congo-Brazzaville', 'CG'],
    ['Republic of the Congo', 'CG'],
    ['Republic of Congo', 'CG'],
    ['Cape Verde', 'CV'],
    ['Cabo Verde', 'CV'],
    ['Eswatini', 'SZ'],
    ['Swaziland', 'SZ'],
    ['The Gambia', 'GM'],
    ['Gambia', 'GM'],
    ['São Tomé and Príncipe', 'ST'],
    ['São Tomé and Príncipe'.normalize('NFD'), 'ST'],
    ['Sao Tome & Principe', 'ST'],
    ['Guinea-Bissau', 'GW'],
    ['Guinea Bissau', 'GW'],
    ['Guinea–Bissau', 'GW'],
    ['Equatorial Guinea', 'GQ'],
    ['South Sudan', 'SS'],
    ['United Republic of Tanzania', 'TZ'],
    ['  sOuTh   aFrIcA  ', 'ZA'],
    ['Nígéría', 'NG'],
  ];
  for (const [input, code] of variants) {
    assert.equal(normaliseCountry(context, input), code, input);
    assert.equal(normaliseCountry(context, ` ${input.toLowerCase()} `), code, input);
  }
});

test('Guinea, Sudan and Niger use exact names; Congo requires an explicit choice', () => {
  for (const [input, code] of [
    ['Guinea', 'GN'], ['Guinea-Bissau', 'GW'], ['Equatorial Guinea', 'GQ'],
    ['Sudan', 'SD'], ['South Sudan', 'SS'], ['Niger', 'NE'], ['Nigeria', 'NG'],
    ['COG', 'CG'], ['COD', 'CD'],
  ]) assert.equal(normaliseCountry(context, input), code);
  for (const input of ['Congo', ' conGO ', 'Cóngo']) {
    assert.throws(() => normaliseCountry(context, input), {
      message: 'Country is ambiguous: Congo. Use Democratic Republic of the Congo (CD) or Republic of the Congo (CG).',
    });
  }
});

test('unknown, partial and non-African names fail with the requested message', () => {
  for (const input of [
    'Atlantis', 'Nigeri', 'Equatorial', 'South', 'Republic', 'Congo Republic',
    'United States', 'France', 'USA', 'FRA', 'Western Sahara', 'ESH',
    'constructor', 'toString', '__proto__', 'N', 'N1', '', '   ',
    123, null, undefined, {}, [],
  ]) {
    assert.throws(() => normaliseCountry(context, input), {
      message: `Country not recognised: ${String(input)}. Use a country name such as Nigeria or a two-letter code such as NG.`,
    });
  }
});
