"use strict";

let fs = require('fs');
let readline = require('readline');
let querystring = require('querystring');
let request = require('request-promise-native');
let levelUp = require('level');
let thenLevel = require('then-levelup');
let csvWriteStream = require('csv-write-stream');

function level() {
  let db = levelUp.apply(levelUp, arguments);
  // awful hack for https://github.com/then/then-levelup/issues/3
  db.createWriteStream = {bind: () => {}};
  return thenLevel(db);
}

let apiKey = process.env.GOOGLE_API_KEY;
let placeCache = level('./placecache');

function getFirstGoogleResult(placeName) {
  let queryUri = 'https://www.google.com/search?btnI&q=' +
    encodeURIComponent(placeName);
  return request({uri: queryUri,
    simple: false, resolveWithFullResponse: true,
    followRedirect: false
    })
    .then(res => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        return res.headers.location;
      } else {
        // this is pretty cheap but, honestly, if google isn't confident
        // enough to redirect to the site, let's just tell them to
        // google it themselves.
        // This can probably get replaced with something like the following:
        /*
          // #search #ires h3.r > a
          let firstResultUrl = url.parse(cheerio(res.body)('#ires a').href);
          // assertEqual(firstResultUrl.path, '/url');
          return firstUrl.query.q;
        */
        // but that's looping cheerio in for 2% of scenarios with data that we
        // don't even necessarily trust
        return queryUri;
      }
    });
}

let csvOut = csvWriteStream({
  headers: ['name', 'address', 'phone', 'website']
});
csvOut.pipe(process.stdout);

function outputPlaceRow(placeRow) {
  csvOut.write(placeRow);
}

function outputRowFromFirstResult(response) {
  let best = response.results[0];
  return outputPlaceRow({
    name: best.name,
    address: best.formatted_address,
    phone: best.formatted_phone_number,
    website: best.website
  });
}

function cacheAndOutputResponse(placeName, response) {
  placeCache.put('textsearch ' + placeName, response);
  outputRowFromFirstResult(response);
}

function queryPlaceData(placeName) {
  function placeTextSearchUrl(placeName) {
    return 'https://maps.googleapis.com/maps/api/place/textsearch/json?' +
      querystring.stringify({
        query: placeName,
        key: apiKey
      });
  }
  return request({uri: placeTextSearchUrl(placeName), json:true})
    .then(response => {

    // TODO: take string, do caching magic, THEN parse JSON and logic

    if (response.status == 'OK') {
      cacheAndOutputResponse(placeName, response);
    } else if (response.status == 'ZERO_RESULTS') {
      return getFirstGoogleResult(placeName).then(url => {
        return outputPlaceRow({
          name: placeName,
          website: url
        });
      });
    } else throw response;
  });
}

function processPlaceName(placeName) {
  return placeCache.get(placeName).then(outputRowFromFirstResult)
  .catch(err => {
    if (err.notFound) {
      queryPlaceData(placeName);
    } else {
      throw err;
    }
  });
}

let inlines = readline.createInterface({
  input: process.stdin
});
inlines.on('line', processPlaceName);
