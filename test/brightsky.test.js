/*jshint esversion: 6,node: true */
"use strict";

const assert = require('assert'),
	fixture = require('./fixtures/brightsky-05906-current.json'),
	BrightSkyAPI = require('../apis/brightsky').BrightSkyAPI;

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

function createProvider(log, stationId)
{
	return new BrightSkyAPI([49.5063, 8.55844], stationId === undefined ? '05906' : stationId, 'en', true, log || createLog());
}

function close(actual, expected, tolerance)
{
	assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' should be close to ' + expected);
}

function run(name, test)
{
	try
	{
		test();
		process.stdout.write('ok - ' + name + '\n');
	}
	catch (error)
	{
		process.stderr.write('not ok - ' + name + '\n' + error.stack + '\n');
		process.exitCode = 1;
	}
}

run('parses the supplied Mannheim 05906 current-weather fixture', function ()
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
	assert.strictEqual(report.Condition, 'clear');
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
	const minimal = {timestamp: '2026-07-10T21:30:00Z', source_id: 184398, condition: 'dry'};
	const report = provider.parseCurrentWeather(minimal, fixture.sources, new Date('2026-07-10T22:00:00Z'));
	assert.strictEqual(report.DewPoint, undefined);
	assert.strictEqual(report.TemperatureApparent, undefined);
	assert.strictEqual(report.WindSpeed, undefined);
	assert.strictEqual(report.Rain1h, undefined);

	const calculated = provider.parseCurrentWeather(Object.assign({}, minimal, {
		temperature: 20,
		relative_humidity: 50,
		wind_speed_10: 7.2
	}), fixture.sources, new Date('2026-07-10T22:00:00Z'));
	close(calculated.DewPoint, 9.26, 0.1);
	assert.strictEqual(typeof calculated.TemperatureApparent, 'number');
});

run('rejects a selected source from the wrong DWD station', function ()
{
	const provider = createProvider();
	const wrongSources = [Object.assign({}, fixture.sources[0], {dwd_station_id: '01234'})];
	assert.throws(function ()
	{
		provider.validateStation(fixture.weather, wrongSources, 'current weather');
	}, /does not match configured DWD station 05906/);
});

run('rejects a field-level fallback from the wrong DWD station', function ()
{
	const provider = createProvider();
	const weather = Object.assign({}, fixture.weather, {fallback_source_ids: {pressure_msl: 999999}});
	const sources = fixture.sources.concat([Object.assign({}, fixture.sources[0], {id: 999999, dwd_station_id: '01234'})]);
	assert.throws(function ()
	{
		provider.validateStation(weather, sources, 'current weather');
	}, /source 999999 does not match configured DWD station 05906/);
});

run('warns when the observation timestamp is stale', function ()
{
	const log = createLog();
	const provider = createProvider(log);
	provider.parseCurrentWeather(fixture.weather, fixture.sources, new Date('2026-07-11T00:00:00Z'));
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
	const forecasts = provider.aggregateForecasts(hourly, '2026-07-10T08:00:00+02:00');
	assert.strictEqual(forecasts[0].TemperatureMin, 12);
	assert.strictEqual(forecasts[0].TemperatureMax, 26);
	assert.strictEqual(forecasts[0].RainDay, 3.5);
	assert.strictEqual(forecasts[0].RainChance, 70);
	assert.strictEqual(forecasts[0].WindSpeed, 8.33);
	assert.strictEqual(forecasts[0].WindSpeedMax, 15.28);
	assert.strictEqual(forecasts[0].WindDirection, 'N');
	assert.strictEqual(forecasts[0].Condition, 'rain');
	assert.strictEqual(forecasts[0].RainBool, true);
	assert.match(forecasts[0].SunriseTime, /^\d\d:\d\d:\d\d$/);
	assert.match(forecasts[0].SunsetTime, /^\d\d:\d\d:\d\d$/);
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
	assert.strictEqual(forecast.Condition, 'thunderstorm');
	assert.strictEqual(forecast.ConditionCategory, 9);
	assert.strictEqual(forecast.RainBool, true);
	assert.strictEqual(forecast.SnowBool, true);
	assert.strictEqual(forecast.RainDay, 15);
	assert.strictEqual(forecast.WindSpeedMax, 22.22);
});

run('uses Europe/Berlin local calendar-day boundaries', function ()
{
	const provider = createProvider();
	const hourly = [
		{timestamp: '2026-07-10T21:00:00Z', temperature: 20, condition: 'dry', icon: 'clear-night'},
		{timestamp: '2026-07-10T22:00:00Z', temperature: 10, condition: 'dry', icon: 'clear-night'}
	];
	const forecasts = provider.aggregateForecasts(hourly, '2026-07-10T12:00:00+02:00');
	assert.strictEqual(forecasts[0].TemperatureMin, 20);
	assert.strictEqual(forecasts[1].TemperatureMin, 10);
});

run('keeps the last valid value when an optional field disappears', function ()
{
	const provider = createProvider();
	const merged = provider.mergeAvailable({AirPressure: 1015.1, Temperature: 24.8}, {AirPressure: undefined, Temperature: 25});
	assert.strictEqual(merged.AirPressure, 1015.1);
	assert.strictEqual(merged.Temperature, 25);
});
