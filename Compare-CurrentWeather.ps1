# Compare-CurrentWeather.ps1
# Version: 1.0.0
# Compares live OpenWeatherMap and Bright Sky current-weather observations.
# Created and documented with OpenAI Codex.

#Requires -Version 7.0
#Requires -Modules TUN.CredentialManager

[CmdletBinding()]
param(
    [double]$Latitude = 49.5063,

    [double]$Longitude = 8.55844,

    [string]$DwdStationId = '05906',

    [string]$CredentialTarget = 'OpenWeatherMap-API'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'


function Get-OptionalProperty {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$InputObject,

        [Parameter(Mandatory)]
        [string]$Name
    )

    if ($null -eq $InputObject) {
        return $null
    }

    $property = $InputObject.PSObject.Properties[$Name]

    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}


function Format-Value {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Value,

        [string]$Unit = '',

        [int]$Decimals = 1
    )

    if ($null -eq $Value) {
        return '—'
    }

    $number = 0.0

    if (
        [double]::TryParse(
            [string]$Value,
            [Globalization.NumberStyles]::Any,
            [Globalization.CultureInfo]::InvariantCulture,
            [ref]$number
        )
    ) {
        $formattedNumber = $number.ToString(
            "N$Decimals",
            [Globalization.CultureInfo]::GetCultureInfo('de-DE')
        )

        if ([string]::IsNullOrWhiteSpace($Unit)) {
            return $formattedNumber
        }

        return "$formattedNumber $Unit"
    }

    return [string]$Value
}


function Format-Coordinate {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Latitude,

        [AllowNull()]
        [object]$Longitude
    )

    if ($null -eq $Latitude -or $null -eq $Longitude) {
        return '—'
    }

    $latitudeValue = [double]$Latitude
    $longitudeValue = [double]$Longitude

    return '{0}, {1}' -f `
        $latitudeValue.ToString(
            '0.#####',
            [Globalization.CultureInfo]::GetCultureInfo('de-DE')
        ),
        $longitudeValue.ToString(
            '0.#####',
            [Globalization.CultureInfo]::GetCultureInfo('de-DE')
        )
}


function Convert-ToLocalTimestamp {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Timestamp
    )

    if ($null -eq $Timestamp) {
        return '—'
    }

    try {
        return ([DateTimeOffset]$Timestamp).
            ToLocalTime().
            ToString('dd.MM.yyyy HH:mm:ss')
    }
    catch {
        return [string]$Timestamp
    }
}


function Convert-FromUnixTimestamp {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Timestamp
    )

    if ($null -eq $Timestamp) {
        return '—'
    }

    try {
        return [DateTimeOffset]::FromUnixTimeSeconds([long]$Timestamp).
            ToLocalTime().
            ToString('dd.MM.yyyy HH:mm:ss')
    }
    catch {
        return [string]$Timestamp
    }
}


function Convert-MetresToKilometres {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Value
    )

    if ($null -eq $Value) {
        return $null
    }

    return [double]$Value / 1000
}


function Convert-KilometresPerHourToMetresPerSecond {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Value
    )

    if ($null -eq $Value) {
        return $null
    }

    return [double]$Value / 3.6
}


function Get-ApparentTemperature {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Temperature,

        [AllowNull()]
        [object]$RelativeHumidity,

        [AllowNull()]
        [object]$WindSpeedMetresPerSecond
    )

    if (
        $null -eq $Temperature -or
        $null -eq $RelativeHumidity -or
        $null -eq $WindSpeedMetresPerSecond
    ) {
        return $null
    }

    $temperatureValue = [double]$Temperature
    $humidityValue = [double]$RelativeHumidity
    $windValue = [double]$WindSpeedMetresPerSecond

    if ($humidityValue -lt 0 -or $humidityValue -gt 100) {
        return $null
    }

    # Australische Apparent-Temperature-Formel:
    #
    # AT = T + 0,33 × e − 0,70 × v − 4,00
    #
    # T = Lufttemperatur in °C
    # e = Wasserdampfdruck in hPa
    # v = Windgeschwindigkeit in m/s
    $vapourPressure = (
        $humidityValue / 100
    ) * 6.105 * [Math]::Exp(
        (17.27 * $temperatureValue) /
        (237.7 + $temperatureValue)
    )

    return $temperatureValue +
        (0.33 * $vapourPressure) -
        (0.70 * $windValue) -
        4.00
}


# OpenWeatherMap-API-Key aus dem Windows-Anmeldeinformationstresor lesen.
$storedCredential = Get-StoredCredential `
    -Target $CredentialTarget `
    -AsCredentialObject

if ($null -eq $storedCredential) {
    throw "Im Windows-Tresor wurde kein Eintrag mit dem Namen '$CredentialTarget' gefunden."
}

$apiKey = [string]$storedCredential.Password

if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw "Der Tresoreintrag '$CredentialTarget' enthält keinen API-Key."
}


try {
    Write-Verbose 'Rufe OpenWeatherMap Current Weather ab.'

    $openWeather = Invoke-RestMethod `
        -Method Get `
        -Uri 'https://api.openweathermap.org/data/2.5/weather' `
        -Body @{
            lat   = $Latitude
            lon   = $Longitude
            appid = $apiKey
            units = 'metric'
            lang  = 'de'
        } `
        -TimeoutSec 15

    Write-Verbose 'Rufe Bright Sky Current Weather ab.'

    $brightSky = Invoke-RestMethod `
        -Method Get `
        -Uri 'https://api.brightsky.dev/current_weather' `
        -Body @{
            dwd_station_id = $DwdStationId
            units          = 'dwd'
            tz             = 'Europe/Berlin'
        } `
        -TimeoutSec 15
}
finally {
    $apiKey = $null
}


# Bright-Sky-Wetterobjekt
$bs = Get-OptionalProperty `
    -InputObject $brightSky `
    -Name 'weather'

if ($null -eq $bs) {
    throw 'Bright Sky hat kein weather-Objekt zurückgegeben.'
}


# Bright-Sky-Quelle zur source_id des Wetterdatensatzes suchen
$brightSkySources = Get-OptionalProperty `
    -InputObject $brightSky `
    -Name 'sources'

$brightSkySourceId = Get-OptionalProperty `
    -InputObject $bs `
    -Name 'source_id'

$bsSource = $null

if ($null -ne $brightSkySources -and $null -ne $brightSkySourceId) {
    $bsSource = $brightSkySources |
        Where-Object {
            (Get-OptionalProperty -InputObject $_ -Name 'id') -eq $brightSkySourceId
        } |
        Select-Object -First 1
}


# OpenWeather-Unterobjekte
$openWeatherMain = Get-OptionalProperty `
    -InputObject $openWeather `
    -Name 'main'

$openWeatherClouds = Get-OptionalProperty `
    -InputObject $openWeather `
    -Name 'clouds'

$openWeatherWind = Get-OptionalProperty `
    -InputObject $openWeather `
    -Name 'wind'

$openWeatherRain = Get-OptionalProperty `
    -InputObject $openWeather `
    -Name 'rain'

$openWeatherConditions = Get-OptionalProperty `
    -InputObject $openWeather `
    -Name 'weather'

$openWeatherCoord = Get-OptionalProperty `
    -InputObject $openWeather `
    -Name 'coord'


# OpenWeather-Wetterbeschreibung
$openWeatherCondition = $null

if ($null -ne $openWeatherConditions -and $openWeatherConditions.Count -gt 0) {
    $openWeatherCondition = Get-OptionalProperty `
        -InputObject $openWeatherConditions[0] `
        -Name 'description'
}


# Bright-Sky-Wetterbeschreibung
$brightSkyCondition = Get-OptionalProperty `
    -InputObject $bs `
    -Name 'condition'

if ([string]::IsNullOrWhiteSpace([string]$brightSkyCondition)) {
    $brightSkyCondition = Get-OptionalProperty `
        -InputObject $bs `
        -Name 'icon'
}


# Zeitstempel
$openWeatherTimestamp = Get-OptionalProperty `
    -InputObject $openWeather `
    -Name 'dt'

$brightSkyTimestamp = Get-OptionalProperty `
    -InputObject $bs `
    -Name 'timestamp'


# OpenWeather-Ortsname aus dem JSON-Feld "name"
$openWeatherLocationName = Get-OptionalProperty `
    -InputObject $openWeather `
    -Name 'name'

if ([string]::IsNullOrWhiteSpace([string]$openWeatherLocationName)) {
    $openWeatherLocationName = '—'
}

$openWeatherLocationLabel = if ($openWeatherLocationName -ne '—') {
    "$openWeatherLocationName (Ortsbezeichnung für Koordinaten)"
}
else {
    '—'
}


# Bright-Sky-Stationsname und IDs
if ($null -ne $bsSource) {
    $stationName = Get-OptionalProperty `
        -InputObject $bsSource `
        -Name 'station_name'

    $sourceDwdId = Get-OptionalProperty `
        -InputObject $bsSource `
        -Name 'dwd_station_id'

    $sourceWmoId = Get-OptionalProperty `
        -InputObject $bsSource `
        -Name 'wmo_station_id'

    $identifiers = @()

    if ($null -ne $sourceDwdId) {
        $identifiers += "DWD $sourceDwdId"
    }

    if ($null -ne $sourceWmoId) {
        $identifiers += "WMO $sourceWmoId"
    }

    if ([string]::IsNullOrWhiteSpace([string]$stationName)) {
        $stationName = 'Bright Sky'
    }

    if ($identifiers.Count -gt 0) {
        $brightSkyStation = '{0} ({1})' -f `
            $stationName,
            ($identifiers -join ', ')
    }
    else {
        $brightSkyStation = $stationName
    }
}
else {
    $brightSkyStation = "DWD $DwdStationId"
}


# Koordinaten aus den Antworten
$openWeatherReturnedLatitude = Get-OptionalProperty `
    -InputObject $openWeatherCoord `
    -Name 'lat'

$openWeatherReturnedLongitude = Get-OptionalProperty `
    -InputObject $openWeatherCoord `
    -Name 'lon'

$brightSkyStationLatitude = Get-OptionalProperty `
    -InputObject $bsSource `
    -Name 'lat'

$brightSkyStationLongitude = Get-OptionalProperty `
    -InputObject $bsSource `
    -Name 'lon'


# Weitere Werte
$openWeatherVisibility = Get-OptionalProperty `
    -InputObject $openWeather `
    -Name 'visibility'

$brightSkyVisibility = Get-OptionalProperty `
    -InputObject $bs `
    -Name 'visibility'

$brightSkyWindSpeed = Get-OptionalProperty `
    -InputObject $bs `
    -Name 'wind_speed_10'

$brightSkyWindGust = Get-OptionalProperty `
    -InputObject $bs `
    -Name 'wind_gust_speed_10'

$brightSkyWindSpeedMetresPerSecond =
    Convert-KilometresPerHourToMetresPerSecond $brightSkyWindSpeed

$brightSkyApparentTemperature = Get-ApparentTemperature `
    -Temperature (Get-OptionalProperty $bs 'temperature') `
    -RelativeHumidity (Get-OptionalProperty $bs 'relative_humidity') `
    -WindSpeedMetresPerSecond $brightSkyWindSpeedMetresPerSecond


$rows = @(
    [pscustomobject]@{
        Wert        = 'Zeitpunkt'
        OpenWeather = Convert-FromUnixTimestamp $openWeatherTimestamp
        BrightSky   = Convert-ToLocalTimestamp $brightSkyTimestamp
    }

    [pscustomobject]@{
        Wert        = 'Ort / Wetterquelle'
        OpenWeather = $openWeatherLocationLabel
        BrightSky   = $brightSkyStation
    }

    [pscustomobject]@{
        Wert        = 'Angefragte Koordinaten'
        OpenWeather = Format-Coordinate $Latitude $Longitude
        BrightSky   = "DWD-Station $DwdStationId"
    }

    [pscustomobject]@{
        Wert        = 'Antwort-Koordinaten'
        OpenWeather = Format-Coordinate `
            $openWeatherReturnedLatitude `
            $openWeatherReturnedLongitude
        BrightSky   = Format-Coordinate `
            $brightSkyStationLatitude `
            $brightSkyStationLongitude
    }

    [pscustomobject]@{
        Wert        = 'Temperatur'
        OpenWeather = Format-Value `
            (Get-OptionalProperty $openWeatherMain 'temp') `
            '°C'
        BrightSky   = Format-Value `
            (Get-OptionalProperty $bs 'temperature') `
            '°C'
    }

    [pscustomobject]@{
        Wert        = 'Gefühlte Temperatur'
        OpenWeather = Format-Value `
            (Get-OptionalProperty $openWeatherMain 'feels_like') `
            '°C'
        BrightSky   = Format-Value `
            $brightSkyApparentTemperature `
            '°C'
    }

    [pscustomobject]@{
        Wert        = 'Luftfeuchtigkeit'
        OpenWeather = Format-Value `
            (Get-OptionalProperty $openWeatherMain 'humidity') `
            '%' `
            0
        BrightSky   = Format-Value `
            (Get-OptionalProperty $bs 'relative_humidity') `
            '%' `
            0
    }

    [pscustomobject]@{
        Wert        = 'Taupunkt'
        OpenWeather = '—'
        BrightSky   = Format-Value `
            (Get-OptionalProperty $bs 'dew_point') `
            '°C'
    }

    [pscustomobject]@{
        Wert        = 'Luftdruck'
        OpenWeather = Format-Value `
            (Get-OptionalProperty $openWeatherMain 'pressure') `
            'hPa'
        BrightSky   = Format-Value `
            (Get-OptionalProperty $bs 'pressure_msl') `
            'hPa'
    }

    [pscustomobject]@{
        Wert        = 'Bewölkung'
        OpenWeather = Format-Value `
            (Get-OptionalProperty $openWeatherClouds 'all') `
            '%' `
            0
        BrightSky   = Format-Value `
            (Get-OptionalProperty $bs 'cloud_cover') `
            '%' `
            0
    }

    [pscustomobject]@{
        Wert        = 'Sichtweite'
        OpenWeather = Format-Value `
            (Convert-MetresToKilometres $openWeatherVisibility) `
            'km'
        BrightSky   = Format-Value `
            (Convert-MetresToKilometres $brightSkyVisibility) `
            'km'
    }

    [pscustomobject]@{
        Wert        = 'Wind'
        OpenWeather = Format-Value `
            (Get-OptionalProperty $openWeatherWind 'speed') `
            'm/s'
        BrightSky   = Format-Value `
            $brightSkyWindSpeedMetresPerSecond `
            'm/s'
    }

    [pscustomobject]@{
        Wert        = 'Windböe'
        OpenWeather = Format-Value `
            (Get-OptionalProperty $openWeatherWind 'gust') `
            'm/s'
        BrightSky   = Format-Value `
            (Convert-KilometresPerHourToMetresPerSecond $brightSkyWindGust) `
            'm/s'
    }

    [pscustomobject]@{
        Wert        = 'Windrichtung'
        OpenWeather = Format-Value `
            (Get-OptionalProperty $openWeatherWind 'deg') `
            '°' `
            0
        BrightSky   = Format-Value `
            (Get-OptionalProperty $bs 'wind_direction_10') `
            '°' `
            0
    }

    [pscustomobject]@{
        Wert        = 'Regen 60 Minuten'
        OpenWeather = Format-Value `
            (Get-OptionalProperty $openWeatherRain '1h') `
            'mm'
        BrightSky   = Format-Value `
            (Get-OptionalProperty $bs 'precipitation_60') `
            'mm'
    }

    [pscustomobject]@{
        Wert        = 'Regen 30 Minuten'
        OpenWeather = '—'
        BrightSky   = Format-Value `
            (Get-OptionalProperty $bs 'precipitation_30') `
            'mm'
    }

    [pscustomobject]@{
        Wert        = 'Regen 10 Minuten'
        OpenWeather = '—'
        BrightSky   = Format-Value `
            (Get-OptionalProperty $bs 'precipitation_10') `
            'mm'
    }

    [pscustomobject]@{
        Wert        = 'Solarstrahlung'
        OpenWeather = '—'
        BrightSky   = Format-Value `
            (Get-OptionalProperty $bs 'solar_10') `
            'kWh/m² je 10 Min.'
    }

    [pscustomobject]@{
        Wert        = 'Wetterbedingung'
        OpenWeather = if ($null -ne $openWeatherCondition) {
            $openWeatherCondition
        }
        else {
            '—'
        }
        BrightSky   = if ($null -ne $brightSkyCondition) {
            $brightSkyCondition
        }
        else {
            '—'
        }
    }
)

$rows | Format-Table -AutoSize -Wrap
