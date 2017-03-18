"use strict";

let querystring = require('querystring');
let urllib = require('url');
require('es6-shim');
require('array-includes').shim();
let request = require('request-promise-native');
let levelUp = require('level');
let thenLevel = require('then-levelup');
let xlsx = require('xlsx');
let cheerio = require('cheerio');
let Bottleneck = require('bottleneck');
let argv = require('minimist')(process.argv.slice(2), {
  string: ['key', 'k']
});

function level(...args) {
  return thenLevel(levelUp(...args));
}

let apiKey = argv.key || argv.k || process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error('No Google API key defined');
  process.exit(1);
}
let inputFilename = argv._[0];
if (!inputFilename) {
  console.error('No input filename specified');
  process.exit(1);
}
let outputFilename = argv._[1] ||
  inputFilename.replace(/([^.]+)\./,'$1_updated.');

let startingRow = argv.s || 1;

let placeCache = level('./placecache');
let limiter = new Bottleneck(100);

function getFirstGoogleResult(placeName) {
  let queryUri = 'https://www.google.com/search?btnI&q=' +
    encodeURIComponent(placeName);
  return request({uri: queryUri,
    simple: false, resolveWithFullResponse: true,
    followRedirect: false
    })
    .then(res => {
      // If "I'm Feeling Lucky" redirects us, return where
      if (res.statusCode >= 300 && res.statusCode < 400) {
        return res.headers.location;
      // If "I'm Feeling Lucky" returns a page of search results
      } else if (res.statusCode == 200) {
        // Try to return the destination of the first search result
        try {
          // Parse the first link in the result list
          // A more verbose selector might be '#search #ires h3.r > a'
          let firstResultUrl =
            urllib.parse(cheerio('#ires a', res.body).attr('href'));
          if (firstResultUrl.pathname != '/url') throw firstResultUrl;
          return firstResultUrl.query.q;
        } catch (e) {
          return queryUri;
        }
      // Anything else is an error
      } else throw res;
    });
}

function getFirstMatchingAddressComponent(result, name) {
  return result.address_components.find(
    component => component.types.includes(name)) || {
      // hack to make handling absences slightly simpler
      long_name: '',
      short_name: ''
    };
}
function getLongName(result, name) {
  return getFirstMatchingAddressComponent(result, name).long_name;
}
function getShortName(result, name) {
  return getFirstMatchingAddressComponent(result, name).short_name;
}

// we'd use this if fetching details weren't an extra step -
// since they are, we use a clumsier approach against the address
function getFirstResultInAAL1(results, areaName) {
  return results.find(result =>
    getShortName(result, 'administrative_area_level_1') == areaName);
}

// TODO: maybe check country, too
function getFirstResultWithPenultimateAddressPrefix(results, prefix) {
  return results.find(result => {
    let fields = result.formatted_address.split(/,\s*/);
    let n = fields.length;
    return (fields[n-2].slice(0,prefix.length) == prefix);
  });
}

function cacheBackedQuery(name, query) {
  let prefix = name + ' ';
  return (key) => {
    return placeCache.get(prefix + key)
      .catch(err => {
        if (err.notFound) {
          return limiter.schedule(query, key).then((result) => {
            placeCache.put(prefix + key, result);
            return result;
          });
        } else {
          throw err;
        }
      });
  };
}

function getPlaceTextSearchResults(placeName) {
  return request(
    'https://maps.googleapis.com/maps/api/place/textsearch/json?' +
      querystring.stringify({
        query: placeName,
        key: apiKey
      }));
}

function getPlaceDetails(placeid) {
  return request(
    'https://maps.googleapis.com/maps/api/place/details/json?' +
      querystring.stringify({
        placeid: placeid,
        key: apiKey
      }));
}

let placeTextSearch = cacheBackedQuery('textsearch',
  getPlaceTextSearchResults);

let placeDetails = cacheBackedQuery(
  'details', getPlaceDetails);

let workbook = xlsx.readFile(inputFilename);
let spreadsheet = workbook.Sheets[workbook.SheetNames[0]];

let fieldColumns = {
  name: 'B',
  usState: 'E',
  streetAddress: 'C',
  city: 'D',
  postalCode: 'F',
  phone: 'G',
  notClosed: 'H',
  website: 'I',
  latLon: 'J'
};

// Arguably this should be determined from the data above,
// but really, arguably this should be determined dynamically using headings,
// in which case this last-column check would be a moot point anyway
let minLastColumn = 'J';

let lastCellRegex = /([A-Z]+)(\d+)$/;
let [, lastColumn, lastRow] = lastCellRegex.exec(spreadsheet['!ref']);

lastRow = parseInt(lastRow, 10);

// increase stated range if adding more columns than are already present
if (xlsx.utils.decode_col(lastColumn) < xlsx.utils.decode_col(minLastColumn)) {
  spreadsheet['!ref'] =
    spreadsheet['!ref'].replace(lastCellRegex, minLastColumn + '$2');
}

function processRow(rowNumber) {
  function updateCell(field, value) {
    spreadsheet[fieldColumns[field] + rowNumber] = {v: value};
  }
  let placeName = spreadsheet[fieldColumns.name + rowNumber].v;
  let placeUSState = spreadsheet[fieldColumns.usState + rowNumber].v;
  function updateWithPlaceDetails(placeId) {
    return placeDetails(placeId).then(x => JSON.parse(x))
      .then(response => {
        if (response.status == 'OK') {
          let result = response.result;
          updateCell('city', getLongName(result, 'locality'));
          updateCell('usState',
            getShortName(result, 'administrative_area_level_1'));
          updateCell('postalCode', getLongName(result, 'postal_code'));
          let streetNumber = getLongName(result, 'street_number');
          let route = getLongName(result, 'route');
          let streetAddress = streetNumber ?
            streetNumber + ' ' + route : route;
          updateCell('streetAddress', streetAddress);
          updateCell('phone', result.formatted_phone_number);
          updateCell('website', result.website);
          let loc = result.geometry.location;
          updateCell('latLon', loc.lat + ', ' + loc.lng);
          updateCell('notClosed', result.permanently_closed ? 'N' : 'Y');
        } else if (response.status == 'ZERO_RESULTS') {
          console.log('W ['+ rowNumber +']: Zero results on detail');
          updateCell('notClosed', 'N');
        }
      });
  }
  function updateWithFirstGoogleResult() {
    return getFirstGoogleResult(placeName).then(url => {
      updateCell('website', url);
    });
  }
  return placeTextSearch(placeName).then(x => JSON.parse(x))
    .then(response => {
      if (response.status == 'OK') {
        let mostLikelyResult = getFirstResultWithPenultimateAddressPrefix(
          response.results, placeUSState);
        // if no matching results, treat like zero results
        if (!mostLikelyResult) return updateWithFirstGoogleResult();
        return updateWithPlaceDetails(mostLikelyResult.place_id);
      } else if (response.status == 'ZERO_RESULTS') {
        return updateWithFirstGoogleResult();
      } else throw response;
    }).then(() => {
      console.log('I ['+ rowNumber +']: Complete');
    }).catch(err => {
      let prefix = 'E ['+ rowNumber +']: ';
      if (err instanceof Error) {
        console.log(prefix + err.message);
        console.log(prefix + err.stack.replace(/\n/g,'\n'+prefix));
      } else {
        console.log(prefix + JSON.stringify(err));
      }
    });
}

let rowPromises = [];

for (let i = startingRow; i <= lastRow; i++) {
  rowPromises.push(processRow(i));
}

Promise.all(rowPromises).then(()=>{
  console.log('I: All rows read, writing to '+outputFilename);
  xlsx.writeFile(workbook, outputFilename);
});
