// This module makes use of 'node-fetch' to acces SAPI

const fetch = require('node-fetch');
const debug = require('debug')('bin:lib:fetchContent');
const CAPI_KEY = process.env.CAPI_KEY;
if (! CAPI_KEY ) {
	throw new Error('ERROR: CAPI_KEY not specified in env');
}

const CAPI_PATH = 'https://api.ft.com/enrichedcontent/';
const SAPI_PATH = 'https://api.ft.com/content/search/v1';
const SimpleCache = require('./simple-cache');
const SearchCache = new SimpleCache();
const CACHE_TIME = (process.env.SERVER_CACHE_DURATION_MILLIS || 15 * 60) * 1000; //Default 15 minute server cache

// NB: should only match basic ontology values, maybe with Id suffix, e.g. people and peopleId,
// and *not* other constraint fields such as lastPublishDateTime
const EntityRegex = /^([a-z]+(?:Id)?):(.+)$/;
function rephraseEntityForQueryString(item){
	const match = EntityRegex.exec(item);
	if (match) {
		return match[1] + ':\"' + match[2] + '\"';
	} else {
		return item;
	}
}

// const valid facetNames = [
//   "authors",
//   "authorsId",
//   "brand",
//   "brandId",
//   "category",
//   "format",
//   "genre",
//   "genreId",
//   "icb",
//   "icbId",
//   "iptc",
//   "iptcId",
//   "organisations",
//   "organisationsId",
//   "people",
//   "peopleId",
//   "primarySection",
//   "primarySectionId",
//   "primaryTheme",
//   "primaryThemeId",
//   "regions",
//   "regionsId",
//   "sections",
//   "sectionsId",
//   "specialReports",
//   "specialReportsId",
//   "subjects",
//   "subjectsId",
//   "topics",
//   "topicsId"
// ];

function constructSAPIQuery( params ) {

	const defaults = {
		queryString : "",
	   maxResults : 10,
		     offset : 0,
			aspects : [ "title",  "lifecycle", "location"], // [ "title", "location", "summary", "lifecycle", "metadata"],
		constraints : [],
		facets: {"names":[ "people", "organisations", "topics"], "maxElements":-1}
	};
	const combined = Object.assign({}, defaults, params);
	//console.log(combined)
	let queryString = combined.queryString;
	if (combined.constraints.length > 0 ) {
		// NB: not promises...
		queryString = `"${combined.queryString}" and `
		queryString += combined
		.constraints
		.map(c => { return rephraseEntityForQueryString(c); })
		.join(' and ');
	}

	const full = {
  	queryString: queryString,
  	queryContext : {
		curations: ["ARTICLES", "BLOGS"]
	},
  	resultContext : {
			maxResults : `${combined.maxResults}`,
		 	    offset : `${combined.offset}`,
			   aspects : combined.aspects,
			 sortOrder : "DESC",
			 sortField : "lastPublishDateTime",
			    facets : combined.facets
  	}
	}
	return full;
}

const FetchTimings = {};

function recordFetchTiming( method, timing, resOk, status, statusText ){
	if (!FetchTimings.hasOwnProperty(method)) {
		FetchTimings[method] = [];
	}
	FetchTimings[method].push({
		timing,
		resOk,
		status,
		statusText
	});
}

function summariseFetchTimings(history){
	const summary = {};
	Object.keys(FetchTimings).forEach( method => {
		const totalCount = FetchTimings[method].length;
		history = (history)? history : totalCount;
		const recentFew = FetchTimings[method].slice(- history)
		const count = recentFew.length;
		let statusesNotOk = [];
		let numOk = 0;
		let numNotOk = 0;
		let sum = 0;
		let max = 0;
		let min = -1;
		recentFew.forEach( item => {
			if (item.resOk) {
				numOk = numOk + 1;
			} else {
				numNotOk = numNotOk + 1;
				statusesNotOk.push({ status: item.status, statusText: item.statusText});
			}

			sum = sum + item.timing
			max = Math.max(max, item.timing);
			min = (min == -1)? item.timing : Math.min(min, item.timing);
		});
		summary[method] = {
			totalCount : FetchTimings[method].length,
			count,
			mean : sum / count,
			max,
			min,
			numOk,
			numNotOk,
			statusesNotOk,
		};
	});

	return summary;
}

function fetchWithTiming(url, options={}) {
	const startMillis = Date.now();
	return fetch(url, options)
	.then( res => {
		const endMillis = Date.now();
		const timing = endMillis - startMillis;
		return { res, timing };
	})
}

function fetchResText(url, options){
	return fetchWithTiming(url, options)
	.then(resWithTiming => {
		const method = (options && options.method == 'POST')? 'POST' : 'GET';
		const res = resWithTiming.res;
		const resOk = (res && res.ok);
		const timing = resWithTiming.timing;
		recordFetchTiming( method, timing, resOk, res.status, res.statusText);
		if(resOk){
			return res;
		} else {
			throw new Error(`fetchResText: res not ok: res.status=${res['status']}, res.statusText=${res['statusText']}, url=${url}, options=${JSON.stringify(options)}`);
		}
	})
	.then( res  => res.text() )
	;
}

function search(params) {
	const sapiUrl = `${SAPI_PATH}?apiKey=${CAPI_KEY}`;
	const searchResult = SearchCache.read(params);
	if (searchResult !== undefined) {
		console.log(`Cache hit: ${params.queryString}: ${params.month}`)
		return Promise.resolve({
			params,
			sapiObj: searchResult
		})
	}
	const sapiQuery = constructSAPIQuery( params );
	const options = {
		method: 'POST',
       	body: JSON.stringify(sapiQuery),
		headers: {
			'Content-Type' : 'application/json',
		}
	};
	debug(`search: sapiQuery=${JSON.stringify(sapiQuery)}`);
	return fetchResText(sapiUrl, options)
	.then( text => {
		let sapiObj;
		try {
		 	sapiObj = JSON.parse(text);
		}
		catch( err ){
			throw new Error(`JSON.parse: err=${err},
				text=${text},
				params=${params}`);
		}
		SearchCache.writeWithExpiry(params, sapiObj, CACHE_TIME);
		return {
			params,
			sapiObj
		};
	} )
	.catch( err => {
		console.log(`ERROR: search: err=${err}.`);
		return { params }; // NB, no sapiObj...
	})
	;
}

function searchWordBetweenRange(word, afterIsotime, beforeIsotime, params={}) {
	const timeConstraints = [
		`lastPublishDateTime:>${afterIsotime}`,
		`lastPublishDateTime:<${beforeIsotime}`
	];
	const queryString = word;
	if (! params.hasOwnProperty('constraints')) {
		params.constraints = [];
	}
	params.constraints = params.constraints.concat( timeConstraints );
	params.month = afterIsotime;
	params.queryString = queryString;

	return search( params );
}

function defaultSearchTerms(){
	return new Promise((resolve, reject) => {
		const defaultSearch = [process.env.DEFAULT_KIOSK] || [];
		resolve(defaultSearch);
	});
}

module.exports = {
	searchWordBetweenRange,
	summariseFetchTimings,
	defaultSearchTerms
};
