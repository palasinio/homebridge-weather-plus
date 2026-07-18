/*jshint esversion: 6,node: true,-W041: false */
"use strict";

const axios = require('axios'),
	converter = require('../util/converter'),
	geoTz = require('geo-tz'),
	moment = require('moment-timezone'),
	wformula = require('weather-formulas');

const conditionTranslations = {
	en: {
		clear: 'Clear',
		dry: 'Dry',
		'partly-cloudy': 'Partly cloudy',
		cloudy: 'Cloudy',
		fog: 'Fog',
		wind: 'Windy',
		rain: 'Rain',
		sleet: 'Sleet',
		snow: 'Snow',
		hail: 'Hail',
		thunderstorm: 'Thunderstorm'
	},
	de: {
		clear: 'Klar',
		dry: 'Trocken',
		'partly-cloudy': 'Teilweise bewölkt',
		cloudy: 'Bewölkt',
		fog: 'Nebel',
		wind: 'Windig',
		rain: 'Regen',
		sleet: 'Schneeregen',
		snow: 'Schnee',
		hail: 'Hagel',
		thunderstorm: 'Gewitter'
	}
};

class BrightSkyAPI
{
	constructor(locationGeo, dwdStationId, language, conditionDetail, log)
	{
		this.apiBaseURL = 'https://api.brightsky.dev';
		this.locationGeo = locationGeo;
		this.dwdStationId = dwdStationId ? String(dwdStationId).padStart(5, '0') : undefined;
		this.language = language || 'en';
		this.conditionDetail = conditionDetail;
		this.log = log;
		this.timeout = 10000;
		this.staleAfterMinutes = 90;
		this.forecastDays = 8;
		this.lastReport = {};
		this.attribution = 'Powered by Bright Sky / DWD Open Data';

		if (!Array.isArray(this.locationGeo) || this.locationGeo.length !== 2)
		{
			throw new Error('Bright Sky requires locationGeo with latitude and longitude.');
		}
		this.timezone = geoTz(this.locationGeo[0], this.locationGeo[1])[0] || 'UTC';

		this.reportCharacteristics = [
			'AirPressure',
			'CloudCover',
			'Condition',
			'ConditionCategory',
			'DewPoint',
			'Humidity',
			'ObservationStation',
			'ObservationTime',
			'Rain1h',
			'RainBool',
			'SnowBool',
			'SolarRadiation',
			'Temperature',
			'TemperatureApparent',
			'Visibility',
			'WindDirection',
			'WindSpeed',
			'WindSpeedMax'
		];
		this.forecastCharacteristics = [
			'AirPressure',
			'CloudCover',
			'Condition',
			'ConditionCategory',
			'DewPoint',
			'ForecastDay',
			'Humidity',
			'RainBool',
			'RainChance',
			'RainDay',
			'SnowBool',
			'SunriseTime',
			'SunsetTime',
			'TemperatureApparent',
			'TemperatureMax',
			'TemperatureMin',
			'Visibility',
			'WindDirection',
			'WindSpeed',
			'WindSpeedMax'
		];
	}

	update(forecastDays, callback)
	{
		this.log.debug('Updating weather with Bright Sky');
		const wantsForecast = Array.isArray(forecastDays) && forecastDays.length > 0;
		const requests = [this.settle(this.loadCurrent())];
		if (wantsForecast)
		{
			requests.push(this.settle(this.loadForecast()));
		}

		Promise.all(requests)
			.then((results) =>
			{
				const weather = {forecasts: []};
				let successful = false;
				if (results[0].value)
				{
					weather.report = results[0].value;
					successful = true;
				}
				else
				{
					this.logRequestError('current weather', results[0].error);
				}

				if (wantsForecast && results[1].value)
				{
					weather.forecasts = results[1].value;
					successful = true;
				}
				else if (wantsForecast)
				{
					this.logRequestError('forecast', results[1].error);
				}

				callback(successful ? null : results[0].error || results[1].error, successful ? weather : undefined);
			});
	}

	loadCurrent()
	{
		return this.getWeatherData('/current_weather', {})
			.then((current) =>
			{
				this.validateStation(current.weather, current.sources, 'current weather');
				const values = this.filterForeignFallbackValues(current.weather, current.sources, 'current weather');
				const parsed = this.parseCurrentWeather(values, current.sources);
				this.lastReport = this.mergeAvailable(this.lastReport, parsed);
				return Object.assign({}, this.lastReport);
			});
	}

	loadForecast()
	{
		const first = moment.tz(this.timezone).startOf('day');
		const last = first.clone().add(this.forecastDays, 'days').subtract(1, 'hour');
		return this.getWeatherData('/weather', {date: first.format(), last_date: last.format()})
			.then((hourly) =>
			{
				this.validateForecastStations(hourly.weather, hourly.sources);
				const values = (hourly.weather || []).map((record) =>
					this.filterForeignFallbackValues(record, hourly.sources, 'forecast'));
				return this.aggregateForecasts(values);
			});
	}

	settle(promise)
	{
		return promise.then((value) => ({value: value}), (error) => ({error: error}));
	}

	logRequestError(context, error)
	{
		if (error && error.response && error.response.status === 429)
		{
			this.log.warn('Bright Sky ' + context + ' rate limit reached; keeping the last valid values.');
		}
		else if (error && error.code === 'ECONNABORTED')
		{
			this.log.error('Bright Sky ' + context + ' request timed out after ' + this.timeout + ' ms.');
		}
		else
		{
			this.log.error('Bright Sky ' + context + ' update failed: ' + (error ? error.message : 'unknown error'));
		}
	}

	getWeatherData(path, parameters)
	{
		const params = Object.assign({
			tz: this.timezone,
			units: 'dwd'
		}, parameters);
		if (this.dwdStationId)
		{
			params.dwd_station_id = this.dwdStationId;
		}
		else
		{
			params.lat = this.locationGeo[0];
			params.lon = this.locationGeo[1];
		}
		return axios.get(this.apiBaseURL + path, {params: params, timeout: this.timeout})
			.then((response) => response.data);
	}

	parseCurrentWeather(values, sources, now)
	{
		if (!values || !values.timestamp)
		{
			throw new Error('Bright Sky returned no current weather record.');
		}
		const source = this.sourceFor(values.source_id, sources);
		const timestamp = moment.parseZone(values.timestamp);
		const ageMinutes = moment(now || undefined).diff(timestamp, 'minutes', true);
		this.log.debug('Bright Sky observation timestamp %s is %s minutes old.', values.timestamp, Math.round(ageMinutes));
		if (ageMinutes > this.staleAfterMinutes)
		{
			this.log.warn('Bright Sky observation is stale (' + Math.round(ageMinutes) + ' minutes old, timestamp ' + values.timestamp + ').');
		}
		else if (ageMinutes < -5)
		{
			this.log.warn('Bright Sky observation timestamp is in the future: ' + values.timestamp);
		}

		const conditionKey = this.getConditionKey(values);
		const rainState = this.getRainState(values, conditionKey);
		const snowState = this.getSnowState(values, conditionKey);
		const report = {
			ObservationTime: timestamp.tz(this.timezone).format('HH:mm:ss'),
			ObservationStation: this.stationLabel(source)
		};
		if (conditionKey)
		{
			report.Condition = this.translateCondition(conditionKey);
			report.ConditionCategory = this.getConditionCategory(conditionKey, this.conditionDetail);
		}
		if (rainState !== undefined) report.RainBool = rainState;
		if (snowState !== undefined) report.SnowBool = snowState;
		this.assignNumber(report, 'Temperature', values.temperature);
		this.assignNumber(report, 'Humidity', values.relative_humidity);
		this.assignNumber(report, 'AirPressure', values.pressure_msl);
		this.assignNumber(report, 'CloudCover', values.cloud_cover);
		this.assignNumber(report, 'Visibility', this.divide(values.visibility, 1000));
		this.assignNumber(report, 'WindSpeed', this.divide(this.firstNumber(values, ['wind_speed_10', 'wind_speed_30', 'wind_speed_60']), 3.6));
		this.assignNumber(report, 'WindSpeedMax', this.divide(this.firstNumber(values, ['wind_gust_speed_10', 'wind_gust_speed_30', 'wind_gust_speed_60']), 3.6));
		const direction = this.firstNumber(values, ['wind_direction_10', 'wind_direction_30', 'wind_direction_60']);
		if (this.isNumber(direction)) report.WindDirection = converter.getWindDirection(direction);

		this.assignNumber(report, 'Rain1h', values.precipitation_60);
		const solar = this.intervalEnergyToPower(values);
		this.assignNumber(report, 'SolarRadiation', solar);

		let dewPoint = values.dew_point;
		if (!this.isNumber(dewPoint)) dewPoint = this.calculateDewPoint(values.temperature, values.relative_humidity);
		this.assignNumber(report, 'DewPoint', dewPoint);
		this.assignNumber(report, 'TemperatureApparent', this.calculateApparentTemperature(values.temperature, values.relative_humidity,
			this.divide(this.firstNumber(values, ['wind_speed_10', 'wind_speed_30', 'wind_speed_60']), 3.6)));

		this.log.debug('Bright Sky source identity: source_id=%s, dwd_station_id=%s, wmo_station_id=%s, observation_type=%s, station_name=%s, lat=%s, lon=%s, timestamp=%s',
			values.source_id, source && source.dwd_station_id, source && source.wmo_station_id, source && source.observation_type,
			source && source.station_name, source && source.lat, source && source.lon, values.timestamp);
		return report;
	}

	aggregateForecasts(hourlyValues, referenceTime)
	{
		const start = moment.tz(referenceTime || undefined, this.timezone).startOf('day');
		const groups = [];
		(hourlyValues || []).forEach((value) =>
		{
			if (!value || !value.timestamp) return;
			const local = moment.parseZone(value.timestamp).tz(this.timezone);
			const day = local.clone().startOf('day').diff(start, 'days');
			if (day >= 0 && day < this.forecastDays)
			{
				if (!groups[day]) groups[day] = [];
				groups[day].push(value);
			}
		});

		const forecasts = [];
		groups.forEach((values, day) =>
		{
			if (!values || values.length === 0) return;
			const date = start.clone().add(day, 'days');
			const conditionValue = this.selectDailyCondition(values);
			const forecast = {
				ForecastDay: date.clone().locale(this.language).format('dddd'),
				SunriseTime: this.calculateSunTime(date, true),
				SunsetTime: this.calculateSunTime(date, false)
			};
			if (conditionValue)
			{
				const conditionKey = this.getConditionKey(conditionValue);
				forecast.Condition = this.translateCondition(conditionKey);
				forecast.ConditionCategory = this.getConditionCategory(conditionKey, this.conditionDetail);
			}
			const rainState = this.combineStates(values.map((value) => this.getRainState(value, this.getConditionKey(value))));
			const snowState = this.combineStates(values.map((value) => this.getSnowState(value, this.getConditionKey(value))));
			if (rainState !== undefined) forecast.RainBool = rainState;
			if (snowState !== undefined) forecast.SnowBool = snowState;
			this.assignNumber(forecast, 'TemperatureMax', this.maximum(values, 'temperature'));
			this.assignNumber(forecast, 'TemperatureMin', this.minimum(values, 'temperature'));
			this.assignNumber(forecast, 'Humidity', this.average(values, 'relative_humidity'));
			this.assignNumber(forecast, 'AirPressure', this.average(values, 'pressure_msl'));
			this.assignNumber(forecast, 'CloudCover', this.average(values, 'cloud_cover'));
			this.assignNumber(forecast, 'DewPoint', this.averageCalculated(values, (value) =>
				this.isNumber(value.dew_point) ? value.dew_point : this.calculateDewPoint(value.temperature, value.relative_humidity)));
			this.assignNumber(forecast, 'Visibility', this.divide(this.average(values, 'visibility'), 1000));
			this.assignNumber(forecast, 'RainDay', this.sum(values, 'precipitation'));
			this.assignNumber(forecast, 'RainChance', this.maximum(values, 'precipitation_probability'));
			this.assignNumber(forecast, 'WindSpeed', this.divide(this.maximum(values, 'wind_speed'), 3.6));
			this.assignNumber(forecast, 'WindSpeedMax', this.divide(this.maximum(values, 'wind_gust_speed'), 3.6));
			const windDirection = this.circularMean(values.map((value) => value.wind_direction));
			if (this.isNumber(windDirection)) forecast.WindDirection = converter.getWindDirection(windDirection);
			this.assignNumber(forecast, 'TemperatureApparent', this.averageCalculated(values, (value) =>
				this.calculateApparentTemperature(value.temperature, value.relative_humidity, this.divide(value.wind_speed, 3.6)), true));
			forecasts[day] = forecast;
		});
		return forecasts;
	}

	validateStation(record, sources, context)
	{
		if (!this.dwdStationId) return;
		const source = this.sourceFor(record && record.source_id, sources);
		if (!source || source.dwd_station_id !== this.dwdStationId)
		{
			throw new Error('Bright Sky ' + context + ' main source does not match configured DWD station ' + this.dwdStationId + '.');
		}
	}

	filterForeignFallbackValues(record, sources, context)
	{
		const filtered = Object.assign({}, record);
		if (!this.dwdStationId || !record || !record.fallback_source_ids) return filtered;
		// Bright Sky maps each filled parameter to the source that supplied it.
		// Keep a valid main report, but omit fields filled from another station.
		Object.keys(record.fallback_source_ids).forEach((field) =>
		{
			const sourceId = record.fallback_source_ids[field];
			const source = this.sourceFor(sourceId, sources);
			if (!source || source.dwd_station_id !== this.dwdStationId)
			{
				delete filtered[field];
				this.log.warn('Ignoring Bright Sky ' + context + ' field ' + field + ' from fallback source ' + sourceId +
					' because it does not match configured DWD station ' + this.dwdStationId + '.');
			}
		});
		return filtered;
	}

	validateForecastStations(records, sources)
	{
		if (!this.dwdStationId) return;
		(records || []).forEach((record) => this.validateStation(record, sources, 'forecast'));
	}

	sourceFor(sourceId, sources)
	{
		return (sources || []).find((source) => source.id === sourceId);
	}

	stationLabel(source)
	{
		if (!source) return this.dwdStationId ? 'DWD ' + this.dwdStationId : 'Bright Sky';
		const identifiers = [];
		if (source.dwd_station_id) identifiers.push('DWD ' + source.dwd_station_id);
		if (source.wmo_station_id) identifiers.push('WMO ' + source.wmo_station_id);
		return (source.station_name || 'Bright Sky') + (identifiers.length ? ' (' + identifiers.join(', ') + ')' : '');
	}

	getConditionKey(value)
	{
		if (!value) return undefined;
		const known = Object.keys(conditionTranslations.en);
		const condition = typeof value.condition === 'string' ? value.condition.toLowerCase() : undefined;
		if (condition && condition !== 'dry') return known.includes(condition) ? condition : undefined;
		const icon = typeof value.icon === 'string' ? value.icon.toLowerCase() : undefined;
		if (icon === 'clear-day' || icon === 'clear-night') return 'clear';
		if (icon === 'partly-cloudy-day' || icon === 'partly-cloudy-night') return 'partly-cloudy';
		if (icon && known.includes(icon)) return icon;
		return condition === 'dry' ? 'dry' : undefined;
	}

	translateCondition(conditionKey)
	{
		if (!conditionKey) return undefined;
		const translations = conditionTranslations[this.language] || conditionTranslations.en;
		return translations[conditionKey] || conditionTranslations.en[conditionKey];
	}

	getConditionCategory(conditionKey, detail)
	{
		if (!conditionKey) return undefined;
		if (conditionKey === 'thunderstorm' || conditionKey === 'wind') return detail ? 9 : (conditionKey === 'wind' ? 1 : 2);
		if (conditionKey === 'snow' || conditionKey === 'sleet') return detail ? 8 : 3;
		if (conditionKey === 'hail') return detail ? 7 : 2;
		if (conditionKey === 'rain') return detail ? 6 : 2;
		if (conditionKey === 'fog') return detail ? 4 : 1;
		if (conditionKey === 'cloudy') return detail ? 3 : 1;
		if (conditionKey === 'partly-cloudy') return detail ? 2 : 1;
		if (conditionKey === 'clear' || conditionKey === 'dry') return 0;
		return undefined;
	}

	selectDailyCondition(values)
	{
		const selected = values.reduce((current, value) => this.conditionPriority(value) > this.conditionPriority(current) ? value : current, values[0]);
		return this.conditionPriority(selected) >= 0 ? selected : undefined;
	}

	conditionPriority(value)
	{
		if (!value) return -1;
		const key = this.getConditionKey(value);
		const priorities = {thunderstorm: 100, hail: 90, snow: 80, sleet: 75, rain: 60, fog: 40, wind: 35,
			cloudy: 20, 'partly-cloudy': 10, clear: 0, dry: 0};
		let priority = priorities[key] === undefined ? -1 : priorities[key];
		if (key === 'rain' && this.isNumber(value.precipitation)) priority += Math.min(value.precipitation, 20);
		return priority;
	}

	getRainState(value, conditionKey)
	{
		const precipitation = this.firstNumber(value, ['precipitation', 'precipitation_60', 'precipitation_30', 'precipitation_10']);
		if (this.isNumber(precipitation) && precipitation > 0) return true;
		if (['rain', 'sleet', 'hail', 'thunderstorm'].includes(conditionKey)) return true;
		if (this.isNumber(precipitation) || conditionKey) return false;
		return undefined;
	}

	getSnowState(value, conditionKey)
	{
		if (conditionKey === 'snow' || conditionKey === 'sleet') return true;
		if (conditionKey) return false;
		return undefined;
	}

	combineStates(states)
	{
		if (states.includes(true)) return true;
		if (states.includes(false)) return false;
		return undefined;
	}

	calculateDewPoint(temperature, humidity)
	{
		if (!this.isNumber(temperature) || !this.isNumber(humidity) || humidity <= 0 || humidity > 100) return undefined;
		// Magnus formula over water (Alduchov and Eskridge constants).
		const b = 17.625;
		const c = 243.04;
		const gamma = Math.log(humidity / 100) + (b * temperature) / (c + temperature);
		return (c * gamma) / (b - gamma);
	}

	calculateApparentTemperature(temperature, humidity, windSpeed)
	{
		if (!this.isNumber(temperature) || !this.isNumber(humidity) || !this.isNumber(windSpeed) || humidity < 0 || humidity > 100) return undefined;
		return wformula.temperature.kelvinToCelcius(wformula.temperature.australianApparentTemperature(
			wformula.temperature.celciusToKelvin(temperature), humidity, windSpeed));
	}

	calculateSunTime(localDate, sunrise)
	{
		const latitude = this.locationGeo[0];
		const longitude = this.locationGeo[1];
		const day = localDate.clone().tz(this.timezone);
		const dayOfYear = parseInt(day.format('DDD'));
		const longitudeHour = longitude / 15;
		const approximateTime = dayOfYear + ((sunrise ? 6 : 18) - longitudeHour) / 24;
		const meanAnomaly = (0.9856 * approximateTime) - 3.289;
		let trueLongitude = meanAnomaly + (1.916 * this.sinDegrees(meanAnomaly)) + (0.020 * this.sinDegrees(2 * meanAnomaly)) + 282.634;
		trueLongitude = this.normalizeDegrees(trueLongitude);
		let rightAscension = this.normalizeDegrees(this.toDegrees(Math.atan(0.91764 * Math.tan(this.toRadians(trueLongitude)))));
		rightAscension += (Math.floor(trueLongitude / 90) * 90) - (Math.floor(rightAscension / 90) * 90);
		rightAscension /= 15;
		const sinDeclination = 0.39782 * this.sinDegrees(trueLongitude);
		const cosDeclination = Math.cos(Math.asin(sinDeclination));
		const cosHourAngle = (this.cosDegrees(90.833) - (sinDeclination * this.sinDegrees(latitude))) /
			(cosDeclination * this.cosDegrees(latitude));
		if (cosHourAngle > 1 || cosHourAngle < -1) return undefined;
		let hourAngle = sunrise ? 360 - this.toDegrees(Math.acos(cosHourAngle)) : this.toDegrees(Math.acos(cosHourAngle));
		hourAngle /= 15;
		const localMeanTime = hourAngle + rightAscension - (0.06571 * approximateTime) - 6.622;
		const utcHour = this.normalizeHours(localMeanTime - longitudeHour);
		const utc = moment.utc([day.year(), day.month(), day.date()]).add(utcHour, 'hours');
		return utc.tz(this.timezone).format('HH:mm:ss');
	}

	intervalEnergyToPower(values)
	{
		if (this.isNumber(values.solar_60)) return values.solar_60 * 1000;
		if (this.isNumber(values.solar_30)) return values.solar_30 * 2000;
		if (this.isNumber(values.solar_10)) return values.solar_10 * 6000;
		return undefined;
	}

	mergeAvailable(previous, next)
	{
		const result = Object.assign({}, previous);
		Object.keys(next).forEach((key) =>
		{
			if (next[key] !== null && next[key] !== undefined && !(typeof next[key] === 'number' && isNaN(next[key]))) result[key] = next[key];
		});
		return result;
	}

	firstNumber(object, keys)
	{
		for (let i = 0; i < keys.length; i++) if (this.isNumber(object[keys[i]])) return object[keys[i]];
		return undefined;
	}

	assignNumber(object, key, value)
	{
		if (this.isNumber(value)) object[key] = Math.round(value * 100) / 100;
	}

	isNumber(value)
	{
		return typeof value === 'number' && isFinite(value);
	}

	divide(value, divisor)
	{
		return this.isNumber(value) ? value / divisor : undefined;
	}

	values(records, property)
	{
		return records.map((record) => record[property]).filter((value) => this.isNumber(value));
	}

	maximum(records, property)
	{
		const values = this.values(records, property);
		return values.length ? Math.max.apply(null, values) : undefined;
	}

	minimum(records, property)
	{
		const values = this.values(records, property);
		return values.length ? Math.min.apply(null, values) : undefined;
	}

	average(records, property)
	{
		return this.averageNumbers(this.values(records, property));
	}

	averageCalculated(records, calculation, maximum)
	{
		const values = records.map(calculation).filter((value) => this.isNumber(value));
		if (!values.length) return undefined;
		return maximum ? Math.max.apply(null, values) : this.averageNumbers(values);
	}

	averageNumbers(values)
	{
		return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
	}

	sum(records, property)
	{
		const values = this.values(records, property);
		return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
	}

	circularMean(values)
	{
		const directions = values.filter((value) => this.isNumber(value));
		if (!directions.length) return undefined;
		const sin = directions.reduce((sum, value) => sum + Math.sin(this.toRadians(value)), 0);
		const cos = directions.reduce((sum, value) => sum + Math.cos(this.toRadians(value)), 0);
		return this.normalizeDegrees(this.toDegrees(Math.atan2(sin, cos)));
	}

	sinDegrees(value) { return Math.sin(this.toRadians(value)); }
	cosDegrees(value) { return Math.cos(this.toRadians(value)); }
	toRadians(value) { return value * Math.PI / 180; }
	toDegrees(value) { return value * 180 / Math.PI; }
	normalizeDegrees(value) { return (value % 360 + 360) % 360; }
	normalizeHours(value) { return (value % 24 + 24) % 24; }
}

module.exports = {
	BrightSkyAPI: BrightSkyAPI
};
