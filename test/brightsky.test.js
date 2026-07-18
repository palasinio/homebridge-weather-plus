/*jshint esversion: 8,node: true */
"use strict";

const assert = require('assert'),
	fixture = require('./fixtures/brightsky-05906-current.json'),
	moment = require('moment-timezone'),
	BrightSkyAPI = require('../apis/brightsky').BrightSkyAPI;

const tests = [];

function createLog()
{
	const entries = {debug: [], info: [], warn: [], error: []};
	const log = {entries: entries};
	Object.keys(entries).forEach((level) =>
	{
		log[level] = function () { entries[level].push(Array.prototype.join.call(arguments, ' ')); };
	});
	return log;
}

function createProvider(log, stationId, language)
{
	return new BrightSkyAPI([49.5063, 8.55844], stationId === undefined ? '05906' : stationId,
		language || 'en', true, log || createLog());
}

function close(actual, expected, tolerance)
{
	assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' should be close to ' + expected);
}

function run(name, test)
{
	tests.push({name: name, test: test});
}

function minimalWeather(overrides)
{
	return Object.assign({timestamp: '2026-07-10T21:30:00Z', source_id: 184398}, overrides || {});
}

function parseCurrent(provider, overrides)
{
	return provider.parseCurrentWeather(minimalWeather(overrides), fixture.sources, new Date('2026-07-10T22:00:00Z'));
}

function forecastResponse(provider)
{
	return {
		weather: [{
			timestamp: moment.tz(provider.timezone).startOf('day').add(12, 'hours').format(),
			source_id: 184398,
			temperature: 20,
			condition: 'dry',
			icon: 'clear-day'
		}],
		sources: fixture.sources
	};
}

function mockTransport(provider, current, forecast)
{
	const calls = [];
	provider.getWeatherData = function (path)
	{
		calls.push(path);
		const result = path === '/current_weather' ? current : forecast;
		return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
	};
	return calls;
}

function update(provider, forecastDays)
{
	return new Promise((resolve) =>
	{
		let callbackCount = 0;
		provider.update(forecastDays, (error, weather) =>
		{
			callbackCount++;
			resolve({error: error, weather: weather, callbackCount: callbackCount});
		});
	});
}

run('parses and localizes the supplied Mannheim 05906 current-weather fixture', function ()
{
	const provider = createProvider();
	provider.validateStation(fixture.weather, fixture.sources, 'current weather');
	const report = provider.parseCurrentWeather(fixture.weather, fixture.sources, new Date('2026-07-10T22:00:00Z'));
	assert.strictEqual(report.ObservationTime, '23:30:00');
	assert.strictEqual(report.ObservationStation, 'Mannheim (DWD 05906, WMO 10729)');
	assert.strictEqual(report.Temperature, 24.8);
	assert.strictEqual(report.DewPoint, 11.58);
	assert.strictEqual(report.Humidity, 44);
	assert.strictEqual(report.AirPressure, 1015.1);
	assert.strictEqual(report.Condition, 'Clear');
	assert.strictEqual(report.ConditionCategory, 0);
	assert.strictEqual(report.Rain1h, 0);
	assert.strictEqual(report.RainBool, false);
	assert.strictEqual(report.SnowBool, false);
	close(report.WindSpeed, 8.3 / 3.6, 0.01);
	close(report.WindSpeedMax, 16.2 / 3.6, 0.01);
});

run('omits unavailable optional values and computes only supported fallbacks', function ()
{
	const provider = createProvider();
	const report = parseCurrent(provider, {condition: 'dry'});
	assert.strictEqual(report.DewPoint, undefined);
	assert.strictEqual(report.TemperatureApparent, undefined);
	assert.strictEqual(report.WindSpeed, undefined);
	assert.strictEqual(report.Rain1h, undefined);

	const calculated = parseCurrent(provider, {condition: 'dry', temperature: 20, relative_humidity: 50, wind_speed_10: 7.2});
	close(calculated.DewPoint, 9.26, 0.1);
	assert.strictEqual(typeof calculated.TemperatureApparent, 'number');
});

run('localizes every stable condition key in English and German', function ()
{
	const expected = {
		clear: ['Clear', 'Klar'], dry: ['Dry', 'Trocken'], 'partly-cloudy': ['Partly cloudy', 'Teilweise bewölkt'],
		cloudy: ['Cloudy', 'Bewölkt'], fog: ['Fog', 'Nebel'], wind: ['Windy', 'Windig'], rain: ['Rain', 'Regen'],
		sleet: ['Sleet', 'Schneeregen'], snow: ['Snow', 'Schnee'], hail: ['Hail', 'Hagel'],
		thunderstorm: ['Thunderstorm', 'Gewitter']
	};
	const english = createProvider(undefined, undefined, 'en');
	const german = createProvider(undefined, undefined, 'de');
	Object.keys(expected).forEach((key) =>
	{
		assert.strictEqual(english.translateCondition(key), expected[key][0]);
		assert.strictEqual(german.translateCondition(key), expected[key][1]);
	});
	assert.strictEqual(createProvider(undefined, undefined, 'fr').translateCondition('rain'), 'Rain');
});

run('maps every stable condition key to categories and precipitation states', function ()
{
	const provider = createProvider();
	const expected = {
		clear: [0, 0, false, false], dry: [0, 0, false, false], 'partly-cloudy': [2, 1, false, false],
		cloudy: [3, 1, false, false], fog: [4, 1, false, false], wind: [9, 1, false, false],
		rain: [6, 2, true, false], sleet: [8, 3, true, true], snow: [8, 3, false, true],
		hail: [7, 2, true, false], thunderstorm: [9, 2, true, false]
	};
	Object.keys(expected).forEach((key) =>
	{
		assert.strictEqual(provider.getConditionCategory(key, true), expected[key][0]);
		assert.strictEqual(provider.getConditionCategory(key, false), expected[key][1]);
		assert.strictEqual(provider.getRainState({}, key), expected[key][2]);
		assert.strictEqual(provider.getSnowState({}, key), expected[key][3]);
	});
});

run('localizes current and forecast conditions only at output time', function ()
{
	const german = createProvider(undefined, undefined, 'de');
	assert.strictEqual(parseCurrent(german, {condition: 'rain', icon: 'rain'}).Condition, 'Regen');
	const forecast = german.aggregateForecasts([
		{timestamp: '2026-07-10T12:00:00+02:00', condition: 'snow', icon: 'snow'}
	], '2026-07-10T00:00:00+02:00')[0];
	assert.strictEqual(forecast.Condition, 'Schnee');
	assert.strictEqual(forecast.ConditionCategory, 8);
});

run('omits condition fields when condition and icon are missing', function ()
{
	const report = parseCurrent(createProvider(), {});
	assert.strictEqual(report.Condition, undefined);
	assert.strictEqual(report.ConditionCategory, undefined);
	assert.strictEqual(report.RainBool, undefined);
	assert.strictEqual(report.SnowBool, undefined);
});

run('omits condition fields for an unknown explicit condition', function ()
{
	const report = parseCurrent(createProvider(), {condition: 'alien-weather'});
	assert.strictEqual(report.Condition, undefined);
	assert.strictEqual(report.ConditionCategory, undefined);
	assert.strictEqual(report.RainBool, undefined);
	assert.strictEqual(report.SnowBool, undefined);
});

run('recognizes dry and clear icon conditions as category zero', function ()
{
	const provider = createProvider();
	const dry = parseCurrent(provider, {condition: 'dry'});
	const clear = parseCurrent(provider, {condition: 'dry', icon: 'clear-night'});
	assert.strictEqual(dry.Condition, 'Dry');
	assert.strictEqual(dry.ConditionCategory, 0);
	assert.strictEqual(clear.Condition, 'Clear');
	assert.strictEqual(clear.ConditionCategory, 0);
});

run('sets Rain1h only from precipitation_60', function ()
{
	const provider = createProvider();
	assert.strictEqual(parseCurrent(provider, {precipitation_60: 1.2}).Rain1h, 1.2);
	assert.strictEqual(parseCurrent(provider, {precipitation_30: 0.6}).Rain1h, undefined);
	assert.strictEqual(parseCurrent(provider, {precipitation_10: 0.2}).Rain1h, undefined);
	assert.strictEqual(parseCurrent(provider, {}).Rain1h, undefined);
	assert.strictEqual(parseCurrent(provider, {precipitation_30: 0.6}).RainBool, true);
	assert.strictEqual(parseCurrent(provider, {precipitation_10: 0}).RainBool, false);
});

run('distinguishes known false, known true and unknown precipitation states', function ()
{
	const provider = createProvider();
	assert.strictEqual(parseCurrent(provider, {condition: 'dry', precipitation_60: 0}).RainBool, false);
	assert.strictEqual(parseCurrent(provider, {condition: 'rain'}).RainBool, true);
	assert.strictEqual(parseCurrent(provider, {precipitation_10: 0.1}).RainBool, true);
	assert.strictEqual(parseCurrent(provider, {}).RainBool, undefined);
	assert.strictEqual(parseCurrent(provider, {condition: 'dry'}).SnowBool, false);
	assert.strictEqual(parseCurrent(provider, {condition: 'sleet'}).SnowBool, true);
	assert.strictEqual(parseCurrent(provider, {precipitation_60: 1}).SnowBool, undefined);
	assert.strictEqual(parseCurrent(provider, {}).SnowBool, undefined);
});

run('accepts a correct main DWD source', function ()
{
	assert.doesNotThrow(() => createProvider().validateStation(fixture.weather, fixture.sources, 'current weather'));
});

run('rejects a selected main source from the wrong DWD station', function ()
{
	const wrongSources = [Object.assign({}, fixture.sources[0], {dwd_station_id: '01234'})];
	assert.throws(() => createProvider().validateStation(fixture.weather, wrongSources, 'current weather'),
		/main source does not match configured DWD station 05906/);
});

run('keeps a correct main source but removes fields from a foreign fallback source', function ()
{
	const log = createLog();
	const provider = createProvider(log);
	const weather = Object.assign({}, fixture.weather, {pressure_msl: 999, fallback_source_ids: {pressure_msl: 999999}});
	const sources = fixture.sources.concat([Object.assign({}, fixture.sources[0], {id: 999999, dwd_station_id: '01234'})]);
	provider.validateStation(weather, sources, 'current weather');
	const filtered = provider.filterForeignFallbackValues(weather, sources, 'current weather');
	assert.strictEqual(filtered.pressure_msl, undefined);
	assert.ok(log.entries.warn.some((entry) => entry.indexOf('pressure_msl') >= 0));
});

run('rejects a missing configured main source', function ()
{
	assert.throws(() => createProvider().validateStation(fixture.weather, [], 'current weather'),
		/main source does not match configured DWD station 05906/);
});

run('allows coordinate-based operation without configured DWD station', function ()
{
	const provider = createProvider(undefined, null);
	assert.doesNotThrow(() => provider.validateStation(fixture.weather, [], 'current weather'));
	const weather = Object.assign({}, fixture.weather, {pressure_msl: 999, fallback_source_ids: {pressure_msl: 999999}});
	assert.strictEqual(provider.filterForeignFallbackValues(weather, [], 'current weather').pressure_msl, 999);
});

run('warns when the observation timestamp is stale', function ()
{
	const log = createLog();
	createProvider(log).parseCurrentWeather(fixture.weather, fixture.sources, new Date('2026-07-11T00:00:00Z'));
	assert.ok(log.entries.warn.some((entry) => entry.indexOf('stale') >= 0));
});

run('aggregates hourly extrema, sums and circular wind direction', function ()
{
	const provider = createProvider();
	const hourly = [
		{timestamp: '2026-07-10T00:00:00+02:00', source_id: 184398, temperature: 12, relative_humidity: 80, pressure_msl: 1012,
			cloud_cover: 20, visibility: 20000, wind_direction: 350, wind_speed: 10, wind_gust_speed: 20, precipitation: 0,
			precipitation_probability: 10, condition: 'dry', icon: 'clear-day'},
		{timestamp: '2026-07-10T12:00:00+02:00', source_id: 184398, temperature: 26, relative_humidity: 40, pressure_msl: 1008,
			cloud_cover: 80, visibility: 10000, wind_direction: 10, wind_speed: 30, wind_gust_speed: 55, precipitation: 3.5,
			precipitation_probability: 70, condition: 'rain', icon: 'rain'}
	];
	const forecast = provider.aggregateForecasts(hourly, '2026-07-10T08:00:00+02:00')[0];
	assert.strictEqual(forecast.TemperatureMin, 12);
	assert.strictEqual(forecast.TemperatureMax, 26);
	assert.strictEqual(forecast.RainDay, 3.5);
	assert.strictEqual(forecast.RainChance, 70);
	assert.strictEqual(forecast.WindSpeed, 8.33);
	assert.strictEqual(forecast.WindSpeedMax, 15.28);
	assert.strictEqual(forecast.WindDirection, 'N');
	assert.strictEqual(forecast.Condition, 'Rain');
	assert.strictEqual(forecast.RainBool, true);
	assert.match(forecast.SunriseTime, /^\d\d:\d\d:\d\d$/);
	assert.match(forecast.SunsetTime, /^\d\d:\d\d:\d\d$/);
});

run('preserves rain, snow, thunderstorm and maximum gust information', function ()
{
	const provider = createProvider();
	const hourly = [
		{timestamp: '2026-07-10T08:00:00+02:00', condition: 'rain', icon: 'rain', precipitation: 5, wind_gust_speed: 30},
		{timestamp: '2026-07-10T10:00:00+02:00', condition: 'snow', icon: 'snow', precipitation: 2, wind_gust_speed: 45},
		{timestamp: '2026-07-10T12:00:00+02:00', condition: 'thunderstorm', icon: 'thunderstorm', precipitation: 8, wind_gust_speed: 80}
	];
	const forecast = provider.aggregateForecasts(hourly, '2026-07-10T00:00:00+02:00')[0];
	assert.strictEqual(forecast.Condition, 'Thunderstorm');
	assert.strictEqual(forecast.ConditionCategory, 9);
	assert.strictEqual(forecast.RainBool, true);
	assert.strictEqual(forecast.SnowBool, true);
	assert.strictEqual(forecast.RainDay, 15);
	assert.strictEqual(forecast.WindSpeedMax, 22.22);
});

run('uses Europe/Berlin local calendar-day boundaries', function ()
{
	const forecasts = createProvider().aggregateForecasts([
		{timestamp: '2026-07-10T21:00:00Z', temperature: 20, condition: 'dry', icon: 'clear-night'},
		{timestamp: '2026-07-10T22:00:00Z', temperature: 10, condition: 'dry', icon: 'clear-night'}
	], '2026-07-10T12:00:00+02:00');
	assert.strictEqual(forecasts[0].TemperatureMin, 20);
	assert.strictEqual(forecasts[1].TemperatureMin, 10);
});

run('keeps the last valid value when an optional field disappears', function ()
{
	const merged = createProvider().mergeAvailable({AirPressure: 1015.1, Temperature: 24.8}, {AirPressure: undefined, Temperature: 25});
	assert.strictEqual(merged.AirPressure, 1015.1);
	assert.strictEqual(merged.Temperature, 25);
});

run('publishes current and forecast when both requests succeed', async function ()
{
	const provider = createProvider();
	const calls = mockTransport(provider, fixture, forecastResponse(provider));
	const result = await update(provider, [0]);
	assert.strictEqual(result.error, null);
	assert.ok(result.weather.report);
	assert.ok(result.weather.forecasts[0]);
	assert.strictEqual(result.callbackCount, 1);
	assert.deepStrictEqual(calls.sort(), ['/current_weather', '/weather']);
});

run('publishes current when forecast fails', async function ()
{
	const log = createLog();
	const provider = createProvider(log);
	mockTransport(provider, fixture, new Error('forecast failed'));
	const result = await update(provider, [0]);
	assert.strictEqual(result.error, null);
	assert.ok(result.weather.report);
	assert.deepStrictEqual(result.weather.forecasts, []);
	assert.strictEqual(result.callbackCount, 1);
	assert.ok(log.entries.error.some((entry) => entry.indexOf('forecast failed') >= 0));
});

run('publishes forecast without an empty report when current fails', async function ()
{
	const log = createLog();
	const provider = createProvider(log);
	mockTransport(provider, new Error('current failed'), forecastResponse(provider));
	const result = await update(provider, [0]);
	assert.strictEqual(result.error, null);
	assert.strictEqual(result.weather.report, undefined);
	assert.ok(result.weather.forecasts[0]);
	assert.strictEqual(result.callbackCount, 1);
	assert.ok(log.entries.error.some((entry) => entry.indexOf('current failed') >= 0));
});

run('returns one error callback when both requests fail', async function ()
{
	const provider = createProvider();
	mockTransport(provider, new Error('current failed'), new Error('forecast failed'));
	const result = await update(provider, [0]);
	assert.match(result.error.message, /current failed/);
	assert.strictEqual(result.weather, undefined);
	assert.strictEqual(result.callbackCount, 1);
});

run('requests only current weather when no forecast is configured', async function ()
{
	const provider = createProvider();
	const calls = mockTransport(provider, fixture, new Error('forecast must not be requested'));
	const result = await update(provider, []);
	assert.strictEqual(result.error, null);
	assert.ok(result.weather.report);
	assert.deepStrictEqual(calls, ['/current_weather']);
	assert.strictEqual(result.callbackCount, 1);
});

run('retains distinct rate-limit and timeout logging', function ()
{
	const log = createLog();
	const provider = createProvider(log);
	const rateLimit = new Error('too many requests');
	rateLimit.response = {status: 429};
	provider.logRequestError('forecast', rateLimit);
	const timeout = new Error('timeout');
	timeout.code = 'ECONNABORTED';
	provider.logRequestError('current weather', timeout);
	assert.ok(log.entries.warn.some((entry) => entry.indexOf('rate limit') >= 0));
	assert.ok(log.entries.error.some((entry) => entry.indexOf('timed out after 10000 ms') >= 0));
});

async function main()
{
	for (let i = 0; i < tests.length; i++)
	{
		try
		{
			await tests[i].test();
			process.stdout.write('ok - ' + tests[i].name + '\n');
		}
		catch (error)
		{
			process.stderr.write('not ok - ' + tests[i].name + '\n' + error.stack + '\n');
			process.exitCode = 1;
		}
	}
}

main();
