/*jshint esversion: 6,node: true,-W041: false */
"use strict";

const axios = require('axios'),
	converter = require('../util/converter'),
	geoTz = require('geo-tz'),
	moment = require('moment-timezone'),
	wformula = require('weather-formulas');

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
		const requests = [this.getWeatherData('/current_weather', {})];
		const wantsForecast = Array.isArray(forecastDays) && forecastDays.length > 0;
		if (wantsForecast)
		{
			const first = moment.tz(this.timezone).startOf('day');
			const last = first.clone().add(this.forecastDays, 'days').subtract(1, 'hour');
			requests.push(this.getWeatherData('/weather', {
				date: first.format(),
				last_date: last.format()
			}));
		}

		Promise.all(requests)
			.then((results) =>
			{
				const current = results[0];
				this.validateStation(current.weather, current.sources, 'current weather');
				const parsed = this.parseCurrentWeather(current.weather, current.sources);
				this.lastReport = this.mergeAvailable(this.lastReport, parsed);
				const weather = {report: Object.assign({}, this.lastReport), forecasts: []};

				if (wantsForecast)
				{
					const hourly = results[1];
					this.validateForecastStations(hourly.weather, hourly.sources);
					weather.forecasts = this.aggregateForecasts(hourly.weather);
				}
				callback(null, weather);
			})
			.catch((error) =>
			{
				if (error.response && error.response.status === 429)
				{
					this.log.warn('Bright Sky rate limit reached; keeping the last valid values.');
				}
				else
				{
					this.log.error('Bright Sky update failed: ' + error.message);
				}
				callback(error);
			});
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

		const report = {
			ObservationTime: timestamp.tz(this.timezone).format('HH:mm:ss'),
			ObservationStation: this.stationLabel(source),
			Condition: this.conditionLabel(values),
			ConditionCategory: this.getConditionCategory(values.condition, values.icon, this.conditionDetail),
			RainBool: this.isRain(values),
			SnowBool: this.isSnow(values)
		};
		this.assignNumber(report, 'Temperature', values.temperature);
		this.assignNumber(report, 'Humidity', values.relative_humidity);
		this.assignNumber(report, 'AirPressure', values.pressure_msl);
		this.assignNumber(report, 'CloudCover', values.cloud_cover);
		this.assignNumber(report, 'Visibility', this.divide(values.visibility, 1000));
		this.assignNumber(report, 'WindSpeed', this.divide(this.firstNumber(values, ['wind_speed_10', 'wind_speed_30', 'wind_speed_60']), 3.6));
		this.assignNumber(report, 'WindSpeedMax', this.divide(this.firstNumber(values, ['wind_gust_speed_10', 'wind_gust_speed_30', 'wind_gust_speed_60']), 3.6));
		const direction = this.firstNumber(values, ['wind_direction_10', 'wind_direction_30', 'wind_direction_60']);
		if (this.isNumber(direction)) report.WindDirection = converter.getWindDirection(direction);

		const precipitation = this.firstNumber(values, ['precipitation_60', 'precipitation_30', 'precipitation_10']);
		this.assignNumber(report, 'Rain1h', precipitation);
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
				Condition: this.conditionLabel(conditionValue),
				ConditionCategory: this.getConditionCategory(conditionValue.condition, conditionValue.icon, this.conditionDetail),
				RainBool: values.some((value) => this.isRain(value)),
				SnowBool: values.some((value) => this.isSnow(value)),
				SunriseTime: this.calculateSunTime(date, true),
				SunsetTime: this.calculateSunTime(date, false)
			};
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
		const sourceIds = [];
		if (record && record.source_id !== undefined) sourceIds.push(record.source_id);
		if (record && record.fallback_source_ids)
		{
			Object.keys(record.fallback_source_ids).forEach((key) => sourceIds.push(record.fallback_source_ids[key]));
		}
		const invalidSourceId = sourceIds.find((sourceId) =>
		{
			const source = this.sourceFor(sourceId, sources);
			return !source || source.dwd_station_id !== this.dwdStationId;
		});
		if (sourceIds.length === 0 || invalidSourceId !== undefined)
		{
			throw new Error('Bright Sky ' + context + ' source' + (invalidSourceId === undefined ? '' : ' ' + invalidSourceId) +
				' does not match configured DWD station ' + this.dwdStationId + '.');
		}
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

	conditionLabel(value)
	{
		if (!value) return undefined;
		if (value.condition && value.condition !== 'dry') return value.condition;
		const icon = value.icon || '';
		if (icon.indexOf('partly-cloudy') === 0) return 'partly cloudy';
		if (icon === 'cloudy') return 'cloudy';
		if (icon === 'clear-day' || icon === 'clear-night') return 'clear';
		if (icon) return icon.replace(/-/g, ' ');
		return value.condition;
	}

	getConditionCategory(condition, icon, detail)
	{
		const value = condition && condition !== 'dry' ? condition : icon;
		if (value === 'thunderstorm' || value === 'wind') return detail ? 9 : (value === 'wind' ? 1 : 2);
		if (value === 'snow' || value === 'sleet') return detail ? 8 : 3;
		if (value === 'hail') return detail ? 7 : 2;
		if (value === 'rain') return detail ? 6 : 2;
		if (value === 'fog') return detail ? 4 : 1;
		if (value === 'cloudy') return detail ? 3 : 1;
		if (value && value.indexOf('partly-cloudy') === 0) return detail ? 2 : 1;
		return 0;
	}

	selectDailyCondition(values)
	{
		return values.reduce((selected, value) => this.conditionPriority(value) > this.conditionPriority(selected) ? value : selected, values[0]);
	}

	conditionPriority(value)
	{
		if (!value) return -1;
		const key = value.condition && value.condition !== 'dry' ? value.condition : value.icon;
		const priorities = {thunderstorm: 100, hail: 90, snow: 80, sleet: 75, rain: 60, fog: 40, wind: 35,
			cloudy: 20, 'partly-cloudy-day': 10, 'partly-cloudy-night': 10, 'clear-day': 0, 'clear-night': 0, dry: 0};
		let priority = priorities[key] === undefined ? 0 : priorities[key];
		if (key === 'rain' && this.isNumber(value.precipitation)) priority += Math.min(value.precipitation, 20);
		return priority;
	}

	isRain(value)
	{
		return ['rain', 'sleet', 'hail', 'thunderstorm'].includes(value.condition) || this.isNumber(value.precipitation) && value.precipitation > 0 ||
			this.isNumber(value.precipitation_60) && value.precipitation_60 > 0 || this.isNumber(value.precipitation_30) && value.precipitation_30 > 0 ||
			this.isNumber(value.precipitation_10) && value.precipitation_10 > 0;
	}

	isSnow(value)
	{
		return ['snow', 'sleet'].includes(value.condition) || ['snow', 'sleet'].includes(value.icon);
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
