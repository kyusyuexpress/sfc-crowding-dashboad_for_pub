import express from "express";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createCampusForecaster, getRoomNames } from "./forecast.js";
import { createBusForecaster } from "./busforecast.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT) || 3000;

const CLASS_PERIODS = {
    "1": { start: "09:25", end: "10:55" },
    "2": { start: "11:10", end: "12:40" },
    "3": { start: "13:00", end: "14:30" },
    "4": { start: "14:45", end: "16:15" },
    "5": { start: "16:30", end: "18:00" },
    "6": { start: "18:10", end: "19:40" }
};

const ROUTE_CAPACITIES = {
    "湘19": 70,
    "湘23": 70,
    "湘24": 70,
    "湘25": 125
};

const classroomInfo = loadClassroomInfo();
const inboundBusTimetable = loadInboundBusTimetable();
const crowdHistoryState = createCrowdHistoryState();
const CROWD_DATA_DIR = process.env.CROWD_DATA_DIR ||
    path.join(__dirname, "data");
const CROWD_SNAPSHOTS_PATH = path.join(
    CROWD_DATA_DIR,
    "crowd_snapshots.csv"
);
const BUILDING_STATISTICS_PATH = path.join(
    CROWD_DATA_DIR,
    "building_statistics.csv"
);
const CROWD_COLLECTION_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_DEVICES_PER_PERSON = 1.5;
let crowdWriteQueue = Promise.resolve();
let crowdCollectionTimer = null;
const DEFAULT_ASSUMPTIONS = {
    departureRate: 0.3,
    busUseRate: 0.45,
    routeShare: 1
};
const campusForecaster = createCampusForecaster({
    dataDir: CROWD_DATA_DIR,
    classroomInfo: classroomInfo,
    fetchJson: fetchJson,
    getSnapshots: function () { return crowdHistoryState.snapshots; },
    getTokyoTimeParts: getTokyoTimeParts,
    getTokyoDateString: getTokyoDateString,
    devicesPerPerson: DEFAULT_DEVICES_PER_PERSON
});
const outboundBusCache = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "staticfile_public"), {
    extensions: ["html"]
}));

function loadClassroomInfo() {
    const candidates = [
        process.env.CLASSROOM_INFO_PATH,
        path.join(__dirname, "sfc_classrooms.json"),
        path.join(__dirname, "kyousitu_size.json"),
        path.join(__dirname, "staticfile_public", "sfc_classrooms.json"),
        path.join(__dirname, "example-data", "kyousitu_size.json"),
        path.join(__dirname, "staticfile_public", "kyousitu_size.json")
    ].filter(Boolean);

    const filePath = candidates.find(function (candidate) {
        return fs.existsSync(candidate);
    });

    if (!filePath) {
        throw new Error(
            "教室情報JSONが見つかりません。" +
            "sfc_classrooms.json、kyousitu_size.json、" +
            "またはCLASSROOM_INFO_PATHを指定してください。"
        );
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadInboundBusTimetable() {
    const candidates = [
        process.env.INBOUND_BUS_TIMETABLE_PATH,
        path.join(__dirname, "kanachu_jikoku_from_shonandai.json"),
        path.join(
            __dirname,
            "staticfile_public",
            "kanachu_jikoku_from_shonandai.json"
        ),
        path.join(__dirname, "example-data", "kanachu_jikoku_from_shonandai.json")
    ].filter(Boolean);

    const filePath = candidates.find(function (candidate) {
        return fs.existsSync(candidate);
    });

    if (!filePath) {
        throw new Error(
            "登校側バス時刻表JSONが見つかりません。" +
            "kanachu_jikoku_from_shonandai.json、または" +
            "INBOUND_BUS_TIMETABLE_PATHを指定してください。"
        );
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getScheduleType(dateString, override) {
    const allowedTypes = ["weekday", "saturday", "holiday"];

    if (override !== undefined) {
        const requestedType = String(override);
        if (!allowedTypes.includes(requestedType)) {
            const error = new Error(
                "scheduleTypeはweekday、saturday、holidayのいずれかで指定してください。"
            );
            error.status = 400;
            throw error;
        }
        return requestedType;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
        const error = new Error("dateはYYYY-MM-DD形式で指定してください。");
        error.status = 400;
        throw error;
    }

    // 正午を使うことで、タイムゾーン境界による曜日ずれを避ける。
    const date = new Date(dateString + "T12:00:00+09:00");
    if (Number.isNaN(date.getTime())) {
        const error = new Error("dateは有効な日付で指定してください。");
        error.status = 400;
        throw error;
    }

    const day = date.getUTCDay();
    if (day === 6) return "saturday";
    if (day === 0) return "holiday";
    return "weekday";
}

function extractTime(isoDateTime) {
    const match = String(isoDateTime).match(/T(\d{2}:\d{2}:\d{2})/);
    if (!match) {
        throw new Error("時刻表内のdepartureTimeを解釈できません。");
    }
    return match[1];
}

/*
 * d01（湘23・湘24）とd02（湘25）を、既存のバスAPIと同様に
 * timetables[].departures[]として扱える形へ統合する。
 */
function getInboundBusData(dateString, scheduleTypeOverride) {
    const scheduleType = getScheduleType(
        dateString,
        scheduleTypeOverride
    );
    const sourceKeys = ["d01", "d02"];
    const departures = [];

    sourceKeys.forEach(function (sourceKey) {
        const source = inboundBusTimetable[sourceKey];
        if (!source) return;

        (source.regular || []).forEach(function (routeGroup) {
            (routeGroup.schedules || [])
                .filter(function (schedule) {
                    return schedule.scheduleType === scheduleType;
                })
                .forEach(function (schedule) {
                    (schedule.trips || []).forEach(function (trip) {
                        const departureTime = extractTime(
                            trip.departureTime
                        );

                        departures.push({
                            id: trip.id,
                            sourceKey: sourceKey,
                            routeShortName: trip.courseName,
                            routeGroupName: routeGroup.courseGroupName,
                            departureTime: departureTime,
                            departureDateTime:
                                dateString + "T" + departureTime + "+09:00",
                            origin: source.busstopName,
                            destination: trip.destination,
                            via: trip.via,
                            operatorName: trip.operatorName,
                            vehicleCapacity:
                                ROUTE_CAPACITIES[trip.courseName] || null
                        });
                    });
                });
        });
    });

    departures.sort(function (a, b) {
        return timeToMinutes(a.departureTime) -
            timeToMinutes(b.departureTime);
    });

    return {
        date: dateString,
        scheduleType: scheduleType,
        direction: "to_sfc",
        sources: sourceKeys,
        timetables: [
            {
                origin: "湘南台駅西口",
                destination: "慶応大学・慶応中高等部前",
                departures: departures
            }
        ]
    };
}

function timeToMinutes(time) {
    const parts = String(time).split(":").map(Number);

    if (
        parts.length < 2 ||
        !Number.isFinite(parts[0]) ||
        !Number.isFinite(parts[1])
    ) {
        throw new TypeError("時刻はHH:MMまたはHH:MM:SS形式で指定してください。");
    }

    return parts[0] * 60 + parts[1] + (parts[2] || 0) / 60;
}

function getTokyoTimeParts(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
    }).formatToParts(date);

    function getPart(type) {
        return Number(parts.find(function (part) {
            return part.type === type;
        }).value);
    }

    return {
        year: getPart("year"),
        month: getPart("month"),
        day: getPart("day"),
        hour: getPart("hour"),
        minute: getPart("minute"),
        second: getPart("second")
    };
}

function getTokyoDateString(date) {
    const parts = getTokyoTimeParts(date);
    return [
        String(parts.year).padStart(4, "0"),
        String(parts.month).padStart(2, "0"),
        String(parts.day).padStart(2, "0")
    ].join("-");
}

function secondsToTime(totalSeconds) {
    const seconds = Math.max(0, Math.min(totalSeconds, 86399));
    const hour = Math.floor(seconds / 3600);
    const minute = Math.floor((seconds % 3600) / 60);
    const second = seconds % 60;

    return [hour, minute, second]
        .map(function (value) {
            return String(value).padStart(2, "0");
        })
        .join(":");
}

function getDefaultBusWindow(date) {
    const time = getTokyoTimeParts(date);
    const startSeconds =
        time.hour * 3600 + time.minute * 60 + time.second;

    return {
        start: secondsToTime(startSeconds),
        end: secondsToTime(startSeconds + 3600)
    };
}

function getCurrentClasses(classApiData, now) {
    if (!Array.isArray(classApiData)) {
        throw new TypeError("授業APIのcoursesは配列である必要があります。");
    }

    const time = getTokyoTimeParts(now);
    const currentMinutes =
        time.hour * 60 + time.minute + time.second / 60;

    const currentPeriod = Object.entries(CLASS_PERIODS).find(
        function (entry) {
            const period = entry[1];
            return (
                timeToMinutes(period.start) <= currentMinutes &&
                currentMinutes < timeToMinutes(period.end)
            );
        }
    );

    if (!currentPeriod) {
        return { periodCode: null, period: null, classes: [] };
    }

    const periodCode = currentPeriod[0];

    return {
        periodCode: periodCode,
        period: currentPeriod[1],
        classes: classApiData.filter(function (classInfo) {
            return String(classInfo.periodCode) === periodCode;
        })
    };
}

function calculateCurrentAttendance(currentClasses, seatingRate) {
    const countedRooms = new Set();
    const unknownRooms = new Set();
    let totalAttendance = 0;

    currentClasses.forEach(function (classInfo) {
        getRoomNames(classInfo).forEach(function (roomName) {
            if (countedRooms.has(roomName)) return;

            const classroom = classroomInfo[roomName];
            if (!classroom || !Number.isFinite(classroom.capacity)) {
                unknownRooms.add(roomName);
                return;
            }

            totalAttendance += Math.round(
                classroom.capacity * seatingRate
            );
            countedRooms.add(roomName);
        });
    });

    return {
        totalAttendance: totalAttendance,
        countedRooms: Array.from(countedRooms),
        unknownRooms: Array.from(unknownRooms)
    };
}

function countBusesByRoute(apiData, startTime, endTime) {
    const startMinutes = timeToMinutes(startTime);
    const endMinutes = timeToMinutes(endTime);
    const result = {};

    for (const timetable of apiData.timetables || []) {
        for (const departure of timetable.departures || []) {
            const departureMinutes = timeToMinutes(departure.departureTime);
            if (
                departureMinutes < startMinutes ||
                departureMinutes >= endMinutes
            ) {
                continue;
            }

            const routeName = departure.routeShortName || "系統不明";
            result[routeName] = (result[routeName] || 0) + 1;
        }
    }

    return result;
}

function getNextBuses(apiData, now) {
    const time = getTokyoTimeParts(now);
    const currentMinutes =
        time.hour * 60 + time.minute + time.second / 60;

    const departures = (apiData.timetables || []).flatMap(
        function (timetable) {
            return (timetable.departures || []).map(function (departure) {
                return {
                    ...departure,
                    destination: timetable.destination,
                    departureMinutes: timeToMinutes(departure.departureTime)
                };
            });
        }
    );

    const futureDepartures = departures
        .filter(function (bus) {
            return bus.departureMinutes >= currentMinutes;
        })
        .sort(function (a, b) {
            return a.departureMinutes - b.departureMinutes;
        });

    if (futureDepartures.length === 0) return null;

    const nextTime = futureDepartures[0].departureMinutes;
    const buses = futureDepartures
        .filter(function (bus) {
            return bus.departureMinutes === nextTime;
        })
        .map(function (bus) {
            const result = { ...bus };
            delete result.departureMinutes;
            return result;
        });

    return {
        departureTime: buses[0].departureTime,
        minutesUntil: Math.max(0, Math.ceil(nextTime - currentMinutes)),
        buses: buses
    };
}

function calculateTransportCapacity(busCounts) {
    const unknownRoutes = [];
    let totalCapacity = 0;

    Object.entries(busCounts).forEach(function (entry) {
        const routeName = entry[0];
        const count = entry[1];
        const capacity = ROUTE_CAPACITIES[routeName];

        if (!capacity) {
            unknownRoutes.push(routeName);
            return;
        }

        totalCapacity += count * capacity;
    });

    return { totalCapacity: totalCapacity, unknownRoutes: unknownRoutes };
}

function estimateCampusPopulation(crowdData, averageDevicesPerPerson) {
    const readings = Array.isArray(crowdData.readings)
        ? crowdData.readings
        : [];

    // 建物全体の値だけを使い、建物値とフロア値の重複加算を防ぐ。
    const buildingReadings = readings.filter(function (reading) {
        return reading.areaKey === reading.buildingKey;
    });

    const availableReadings = buildingReadings.filter(function (reading) {
        return Number.isFinite(reading.ClientCount);
    });

    const connectedDeviceCount = availableReadings.reduce(
        function (total, reading) {
            return total + reading.ClientCount;
        },
        0
    );

    const unavailableBuildings = buildingReadings
        .filter(function (reading) {
            return !Number.isFinite(reading.ClientCount);
        })
        .map(function (reading) {
            return reading.buildingKey;
        });

    return {
        connectedDeviceCount: connectedDeviceCount,
        averageDevicesPerPerson: averageDevicesPerPerson,
        estimatedPopulation: Math.round(
            connectedDeviceCount / averageDevicesPerPerson
        ),
        measuredAt: crowdData.measuredAt || null,
        generatedAt: crowdData.generatedAt || null,
        buildingCount: availableReadings.length,
        unavailableBuildings: unavailableBuildings
    };
}

/* CROWD_HISTORY_FUNCTIONS_START */

const CROWD_HISTORY_RULES = {
    timeSlotMinutes: 30,
    minimumAverageSamples: 3,
    warningIntervalMinutes: 15,
    invalidIntervalMinutes: 30,
    invalidMissingRatio: 0.2
};

const CROWD_EXCLUDED_BUILDINGS = new Set([
    "pe-buildings"
]);

/*
 * 現段階ではメモリ上に保持する。永続化時は、この状態を扱う部分だけを
 * SQLiteなどのリポジトリへ置き換えられる。
 */
function createCrowdHistoryState() {
    return {
        snapshots: [],
        knownBuildingKeys: new Set(),
        buildingStatistics: {}
    };
}

function getCrowdDayType(date) {
    const parts = getTokyoTimeParts(date);
    const tokyoDate = new Date(
        String(parts.year).padStart(4, "0") + "-" +
        String(parts.month).padStart(2, "0") + "-" +
        String(parts.day).padStart(2, "0") + "T12:00:00+09:00"
    );
    const day = tokyoDate.getUTCDay();

    if (day === 6) return "saturday";
    if (day === 0) return "holiday";
    return "weekday";
}

function getCrowdTimeSlot(date, slotMinutes) {
    const parts = getTokyoTimeParts(date);
    const minute = Math.floor(parts.minute / slotMinutes) * slotMinutes;

    return (
        String(parts.hour).padStart(2, "0") + ":" +
        String(minute).padStart(2, "0")
    );
}

function createOnlineStatistic() {
    return {
        count: 0,
        mean: 0,
        m2: 0,
        lastObservedValue: null,
        lastObservedAt: null
    };
}

function addToOnlineStatistic(statistic, value, measuredAt) {
    statistic.count += 1;
    const delta = value - statistic.mean;
    statistic.mean += delta / statistic.count;
    const deltaAfterMeanUpdate = value - statistic.mean;
    statistic.m2 += delta * deltaAfterMeanUpdate;
    statistic.lastObservedValue = value;
    statistic.lastObservedAt = measuredAt;
}

function getStatisticSummary(statistic) {
    if (!statistic || statistic.count === 0) return null;

    return {
        average: statistic.mean,
        sampleCount: statistic.count,
        standardDeviation:
            statistic.count > 1
                ? Math.sqrt(statistic.m2 / (statistic.count - 1))
                : 0,
        lastObservedValue: statistic.lastObservedValue,
        lastObservedAt: statistic.lastObservedAt
    };
}

function getBuildingStatisticContainer(state, buildingKey) {
    if (!state.buildingStatistics[buildingKey]) {
        state.buildingStatistics[buildingKey] = {
            overall: createOnlineStatistic(),
            byDayType: {},
            latestObservedValue: null,
            latestObservedAt: null
        };
    }

    return state.buildingStatistics[buildingKey];
}

function getSlotStatistic(container, dayType, timeSlot, createIfMissing) {
    if (!container.byDayType[dayType]) {
        if (!createIfMissing) return null;
        container.byDayType[dayType] = {};
    }

    if (!container.byDayType[dayType][timeSlot]) {
        if (!createIfMissing) return null;
        container.byDayType[dayType][timeSlot] = createOnlineStatistic();
    }

    return container.byDayType[dayType][timeSlot];
}

function timeSlotToMinutes(timeSlot) {
    const parts = timeSlot.split(":").map(Number);
    return parts[0] * 60 + parts[1];
}

function findNearestSlotStatistic(container, dayType, targetSlot) {
    const slotStatistics = container.byDayType[dayType] || {};
    const targetMinutes = timeSlotToMinutes(targetSlot);
    let nearest = null;

    Object.entries(slotStatistics).forEach(function (entry) {
        const timeSlot = entry[0];
        const statistic = entry[1];

        if (statistic.count < CROWD_HISTORY_RULES.minimumAverageSamples) {
            return;
        }

        const distance = Math.abs(
            timeSlotToMinutes(timeSlot) - targetMinutes
        );

        if (!nearest || distance < nearest.distance) {
            nearest = {
                statistic: statistic,
                timeSlot: timeSlot,
                distance: distance
            };
        }
    });

    return nearest;
}

function estimateMissingBuildingCount(
    state,
    buildingKey,
    measuredAt
) {
    const container = state.buildingStatistics[buildingKey];
    if (!container) return null;

    const measuredDate = new Date(measuredAt);
    const dayType = getCrowdDayType(measuredDate);
    const timeSlot = getCrowdTimeSlot(
        measuredDate,
        CROWD_HISTORY_RULES.timeSlotMinutes
    );
    const exactStatistic = getSlotStatistic(
        container,
        dayType,
        timeSlot,
        false
    );

    if (
        exactStatistic &&
        exactStatistic.count >= CROWD_HISTORY_RULES.minimumAverageSamples
    ) {
        return {
            value: exactStatistic.mean,
            method: "building_day_type_time_average",
            sampleCount: exactStatistic.count,
            standardDeviation:
                getStatisticSummary(exactStatistic).standardDeviation
        };
    }

    const nearest = findNearestSlotStatistic(
        container,
        dayType,
        timeSlot
    );

    if (nearest) {
        return {
            value: nearest.statistic.mean,
            method: "building_day_type_nearest_time_average",
            sampleCount: nearest.statistic.count,
            standardDeviation:
                getStatisticSummary(nearest.statistic).standardDeviation,
            sourceTimeSlot: nearest.timeSlot
        };
    }

    if (Number.isFinite(container.latestObservedValue)) {
        return {
            value: container.latestObservedValue,
            method: "building_latest_observation",
            sampleCount: 1,
            standardDeviation: null,
            sourceMeasuredAt: container.latestObservedAt
        };
    }

    if (
        container.overall.count >=
        CROWD_HISTORY_RULES.minimumAverageSamples
    ) {
        return {
            value: container.overall.mean,
            method: "building_overall_average",
            sampleCount: container.overall.count,
            standardDeviation:
                getStatisticSummary(container.overall).standardDeviation
        };
    }

    return null;
}

function updateBuildingStatistics(state, observedBuildings, measuredAt) {
    const measuredDate = new Date(measuredAt);
    const dayType = getCrowdDayType(measuredDate);
    const timeSlot = getCrowdTimeSlot(
        measuredDate,
        CROWD_HISTORY_RULES.timeSlotMinutes
    );

    Object.entries(observedBuildings).forEach(function (entry) {
        const buildingKey = entry[0];
        const value = entry[1];
        const container = getBuildingStatisticContainer(
            state,
            buildingKey
        );
        const slotStatistic = getSlotStatistic(
            container,
            dayType,
            timeSlot,
            true
        );

        // 実測値だけで統計を更新し、補完値は混ぜない。
        addToOnlineStatistic(slotStatistic, value, measuredAt);
        addToOnlineStatistic(container.overall, value, measuredAt);
        container.latestObservedValue = value;
        container.latestObservedAt = measuredAt;
    });
}

function normalizeCrowdObservation(state, crowdData, fetchedAt) {
    const measuredAt = crowdData && crowdData.measuredAt;
    const measuredDate = new Date(measuredAt);

    if (!measuredAt || Number.isNaN(measuredDate.getTime())) {
        throw new TypeError("crowdData.measuredAtが有効な日時ではありません。");
    }

    const readings = Array.isArray(crowdData.readings)
        ? crowdData.readings
        : [];
    const buildingReadings = readings.filter(function (reading) {
        return (
            reading &&
            reading.areaKey === reading.buildingKey &&
            typeof reading.buildingKey === "string" &&
            !CROWD_EXCLUDED_BUILDINGS.has(reading.buildingKey)
        );
    });
    const observedBuildings = {};
    const unavailableFromApi = new Set();

    buildingReadings.forEach(function (reading) {
        state.knownBuildingKeys.add(reading.buildingKey);

        if (Number.isFinite(reading.ClientCount)) {
            observedBuildings[reading.buildingKey] = reading.ClientCount;
        } else {
            unavailableFromApi.add(reading.buildingKey);
        }
    });

    const missingBuildings = Array.from(state.knownBuildingKeys)
        .filter(function (buildingKey) {
            return !Number.isFinite(observedBuildings[buildingKey]);
        })
        .sort();
    const imputations = [];
    const unresolvedBuildings = [];

    missingBuildings.forEach(function (buildingKey) {
        const estimate = estimateMissingBuildingCount(
            state,
            buildingKey,
            measuredAt
        );

        if (!estimate) {
            unresolvedBuildings.push(buildingKey);
            return;
        }

        imputations.push({
            buildingKey: buildingKey,
            estimatedDeviceCount: Math.round(estimate.value),
            method: estimate.method,
            sampleCount: estimate.sampleCount,
            standardDeviation: estimate.standardDeviation,
            sourceTimeSlot: estimate.sourceTimeSlot || null,
            sourceMeasuredAt: estimate.sourceMeasuredAt || null
        });
    });

    const observedDeviceCount = Object.values(observedBuildings).reduce(
        function (total, value) {
            return total + value;
        },
        0
    );
    const estimatedMissingDeviceCount = imputations.reduce(
        function (total, imputation) {
            return total + imputation.estimatedDeviceCount;
        },
        0
    );
    const expectedBuildingCount = state.knownBuildingKeys.size;
    const missingRatio = expectedBuildingCount > 0
        ? missingBuildings.length / expectedBuildingCount
        : 1;
    const qualityReasons = [];
    let quality = "valid";

    if (missingBuildings.length > 0) {
        quality = "warning";
        qualityReasons.push("missing_buildings");
    }

    if (imputations.length > 0) {
        qualityReasons.push("missing_buildings_imputed");
    }

    if (unresolvedBuildings.length > 0) {
        quality = "invalid";
        qualityReasons.push("missing_buildings_unresolved");
    }

    if (missingRatio >= CROWD_HISTORY_RULES.invalidMissingRatio) {
        quality = "invalid";
        qualityReasons.push("too_many_missing_buildings");
    }

    return {
        snapshot: {
            measuredAt: measuredDate.toISOString(),
            fetchedAt: new Date(fetchedAt).toISOString(),
            generatedAt: crowdData.generatedAt || null,
            observedDeviceCount: observedDeviceCount,
            estimatedMissingDeviceCount: estimatedMissingDeviceCount,
            estimatedTotalDeviceCount:
                observedDeviceCount + estimatedMissingDeviceCount,
            availableBuildingCount: Object.keys(observedBuildings).length,
            expectedBuildingCount: expectedBuildingCount,
            missingBuildingCount: missingBuildings.length,
            missingBuildings: missingBuildings,
            unresolvedBuildings: unresolvedBuildings,
            imputations: imputations,
            excludedBuildings: Array.from(CROWD_EXCLUDED_BUILDINGS),
            quality: quality,
            qualityReasons: Array.from(new Set(qualityReasons))
        },
        observedBuildings: observedBuildings
    };
}

function saveCrowdObservation(state, crowdData, fetchedAt) {
    const measuredAt = crowdData && crowdData.measuredAt;
    const measuredDate = new Date(measuredAt);

    if (!measuredAt || Number.isNaN(measuredDate.getTime())) {
        throw new TypeError("crowdData.measuredAtが有効な日時ではありません。");
    }

    const normalizedMeasuredAt = measuredDate.toISOString();
    const existing = state.snapshots.find(function (snapshot) {
        return snapshot.measuredAt === normalizedMeasuredAt;
    });

    if (existing) {
        return { status: "duplicate", snapshot: existing };
    }

    const normalized = normalizeCrowdObservation(
        state,
        crowdData,
        fetchedAt || new Date()
    );

    updateBuildingStatistics(
        state,
        normalized.observedBuildings,
        normalized.snapshot.measuredAt
    );

    state.snapshots.push(normalized.snapshot);
    state.snapshots.sort(function (a, b) {
        return new Date(a.measuredAt) - new Date(b.measuredAt);
    });

    return { status: "saved", snapshot: normalized.snapshot };
}

function combineQuality(firstQuality, secondQuality) {
    const rank = { valid: 0, warning: 1, invalid: 2 };
    return rank[firstQuality] >= rank[secondQuality]
        ? firstQuality
        : secondQuality;
}

function calculateCrowdDelta(
    previousSnapshot,
    currentSnapshot,
    devicesPerPerson
) {
    if (!previousSnapshot || !currentSnapshot) {
        return {
            status: "insufficient_data",
            quality: "invalid",
            qualityReasons: ["two_snapshots_required"]
        };
    }

    const from = new Date(previousSnapshot.measuredAt);
    const to = new Date(currentSnapshot.measuredAt);
    const intervalMinutes = (to - from) / 60000;
    const qualityReasons = [
        ...(previousSnapshot.qualityReasons || []).map(function (reason) {
            return "previous_" + reason;
        }),
        ...(currentSnapshot.qualityReasons || []).map(function (reason) {
            return "current_" + reason;
        })
    ];
    let quality = combineQuality(
        previousSnapshot.quality,
        currentSnapshot.quality
    );

    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
        return {
            status: "invalid",
            quality: "invalid",
            qualityReasons: ["invalid_measurement_interval"]
        };
    }

    if (intervalMinutes > CROWD_HISTORY_RULES.invalidIntervalMinutes) {
        quality = "invalid";
        qualityReasons.push("measurement_interval_too_long");
    } else if (
        intervalMinutes > CROWD_HISTORY_RULES.warningIntervalMinutes
    ) {
        quality = combineQuality(quality, "warning");
        qualityReasons.push("measurement_interval_long");
    }

    const deviceDelta =
        currentSnapshot.estimatedTotalDeviceCount -
        previousSnapshot.estimatedTotalDeviceCount;

    return {
        status: quality === "invalid" ? "invalid" : "available",
        from: previousSnapshot.measuredAt,
        to: currentSnapshot.measuredAt,
        intervalMinutes: Number(intervalMinutes.toFixed(2)),
        deviceDelta: deviceDelta,
        deviceChangePerMinute: Number(
            (deviceDelta / intervalMinutes).toFixed(2)
        ),
        devicesPerPerson: devicesPerPerson,
        estimatedPopulationDelta: Math.round(
            deviceDelta / devicesPerPerson
        ),
        quality: quality,
        qualityReasons: Array.from(new Set(qualityReasons))
    };
}

function getLatestCrowdDelta(state, devicesPerPerson) {
    if (state.snapshots.length < 2) {
        return {
            status: "insufficient_data",
            quality: "invalid",
            qualityReasons: ["two_snapshots_required"]
        };
    }

    return calculateCrowdDelta(
        state.snapshots[state.snapshots.length - 2],
        state.snapshots[state.snapshots.length - 1],
        devicesPerPerson
    );
}

function getCrowdDeltaForSnapshot(
    state,
    measuredAt,
    devicesPerPerson
) {
    const normalizedMeasuredAt = new Date(measuredAt).toISOString();
    const index = state.snapshots.findIndex(function (snapshot) {
        return snapshot.measuredAt === normalizedMeasuredAt;
    });

    if (index <= 0) {
        return {
            status: "insufficient_data",
            quality: "invalid",
            qualityReasons: ["previous_snapshot_required"]
        };
    }

    return calculateCrowdDelta(
        state.snapshots[index - 1],
        state.snapshots[index],
        devicesPerPerson
    );
}

function estimateCampusPopulationFromSnapshot(
    snapshot,
    crowdData,
    averageDevicesPerPerson
) {
    return {
        connectedDeviceCount: snapshot.estimatedTotalDeviceCount,
        observedDeviceCount: snapshot.observedDeviceCount,
        estimatedMissingDeviceCount: snapshot.estimatedMissingDeviceCount,
        averageDevicesPerPerson: averageDevicesPerPerson,
        estimatedPopulation: Math.round(
            snapshot.estimatedTotalDeviceCount / averageDevicesPerPerson
        ),
        measuredAt: snapshot.measuredAt,
        generatedAt: crowdData.generatedAt || null,
        buildingCount: snapshot.availableBuildingCount,
        expectedBuildingCount: snapshot.expectedBuildingCount,
        unavailableBuildings: snapshot.missingBuildings,
        imputations: snapshot.imputations,
        excludedBuildings: snapshot.excludedBuildings,
        quality: snapshot.quality,
        qualityReasons: snapshot.qualityReasons
    };
}

/* CROWD_HISTORY_FUNCTIONS_END */

const CROWD_SNAPSHOT_HEADERS = [
    "measured_at",
    "fetched_at",
    "generated_at",
    "observed_device_count",
    "estimated_missing_device_count",
    "estimated_total_device_count",
    "available_building_count",
    "expected_building_count",
    "missing_building_count",
    "missing_buildings",
    "unresolved_buildings",
    "imputations",
    "excluded_buildings",
    "quality",
    "quality_reasons"
];

const BUILDING_STATISTIC_HEADERS = [
    "building_key",
    "day_type",
    "time_slot",
    "sample_count",
    "mean",
    "m2",
    "last_observed_value",
    "last_observed_at"
];

function encodeCsvCell(value) {
    const text = value === null || value === undefined
        ? ""
        : String(value);

    if (!/[",\r\n]/.test(text)) return text;
    return '"' + text.replace(/"/g, '""') + '"';
}

function encodeCsvRow(values) {
    return values.map(encodeCsvCell).join(",") + "\n";
}

function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];

        if (quoted) {
            if (character === '"' && text[index + 1] === '"') {
                cell += '"';
                index += 1;
            } else if (character === '"') {
                quoted = false;
            } else {
                cell += character;
            }
        } else if (character === '"') {
            quoted = true;
        } else if (character === ",") {
            row.push(cell);
            cell = "";
        } else if (character === "\n") {
            row.push(cell.replace(/\r$/, ""));
            if (row.some(function (value) { return value !== ""; })) {
                rows.push(row);
            }
            row = [];
            cell = "";
        } else {
            cell += character;
        }
    }

    if (cell !== "" || row.length > 0) {
        row.push(cell.replace(/\r$/, ""));
        rows.push(row);
    }

    return rows;
}

function csvRowsToObjects(rows) {
    if (rows.length === 0) return [];
    const headers = rows[0];

    return rows.slice(1).map(function (row) {
        const result = {};
        headers.forEach(function (header, index) {
            result[header] = row[index] === undefined ? "" : row[index];
        });
        return result;
    });
}

function parseCsvNumber(value, defaultValue) {
    const number = Number(value);
    return Number.isFinite(number) ? number : defaultValue;
}

function parseCsvJson(value, defaultValue) {
    if (!value) return defaultValue;
    try {
        return JSON.parse(value);
    } catch (error) {
        return defaultValue;
    }
}

async function ensureCsvFile(filePath, headers) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

    try {
        await fs.promises.access(filePath, fs.constants.F_OK);
    } catch (error) {
        await fs.promises.writeFile(
            filePath,
            encodeCsvRow(headers),
            "utf8"
        );
    }
}

function snapshotToCsvRow(snapshot) {
    return encodeCsvRow([
        snapshot.measuredAt,
        snapshot.fetchedAt,
        snapshot.generatedAt,
        snapshot.observedDeviceCount,
        snapshot.estimatedMissingDeviceCount,
        snapshot.estimatedTotalDeviceCount,
        snapshot.availableBuildingCount,
        snapshot.expectedBuildingCount,
        snapshot.missingBuildingCount,
        JSON.stringify(snapshot.missingBuildings || []),
        JSON.stringify(snapshot.unresolvedBuildings || []),
        JSON.stringify(snapshot.imputations || []),
        JSON.stringify(snapshot.excludedBuildings || []),
        snapshot.quality,
        JSON.stringify(snapshot.qualityReasons || [])
    ]);
}

function csvObjectToSnapshot(row) {
    return {
        measuredAt: row.measured_at,
        fetchedAt: row.fetched_at,
        generatedAt: row.generated_at || null,
        observedDeviceCount: parseCsvNumber(
            row.observed_device_count,
            0
        ),
        estimatedMissingDeviceCount: parseCsvNumber(
            row.estimated_missing_device_count,
            0
        ),
        estimatedTotalDeviceCount: parseCsvNumber(
            row.estimated_total_device_count,
            0
        ),
        availableBuildingCount: parseCsvNumber(
            row.available_building_count,
            0
        ),
        expectedBuildingCount: parseCsvNumber(
            row.expected_building_count,
            0
        ),
        missingBuildingCount: parseCsvNumber(
            row.missing_building_count,
            0
        ),
        missingBuildings: parseCsvJson(row.missing_buildings, []),
        unresolvedBuildings: parseCsvJson(row.unresolved_buildings, []),
        imputations: parseCsvJson(row.imputations, []),
        excludedBuildings: parseCsvJson(row.excluded_buildings, []),
        quality: row.quality || "invalid",
        qualityReasons: parseCsvJson(row.quality_reasons, [])
    };
}

function hydrateOnlineStatistic(row) {
    return {
        count: parseCsvNumber(row.sample_count, 0),
        mean: parseCsvNumber(row.mean, 0),
        m2: parseCsvNumber(row.m2, 0),
        lastObservedValue: row.last_observed_value === ""
            ? null
            : parseCsvNumber(row.last_observed_value, null),
        lastObservedAt: row.last_observed_at || null
    };
}

async function loadCrowdHistoryFromCsv(state) {
    await ensureCsvFile(CROWD_SNAPSHOTS_PATH, CROWD_SNAPSHOT_HEADERS);
    await ensureCsvFile(
        BUILDING_STATISTICS_PATH,
        BUILDING_STATISTIC_HEADERS
    );

    const files = await Promise.all([
        fs.promises.readFile(CROWD_SNAPSHOTS_PATH, "utf8"),
        fs.promises.readFile(BUILDING_STATISTICS_PATH, "utf8")
    ]);
    const snapshotRows = csvRowsToObjects(parseCsv(files[0]));
    const statisticRows = csvRowsToObjects(parseCsv(files[1]));

    state.snapshots.length = 0;
    state.knownBuildingKeys.clear();
    state.buildingStatistics = {};

    snapshotRows.forEach(function (row) {
        if (!row.measured_at) return;
        state.snapshots.push(csvObjectToSnapshot(row));
    });
    state.snapshots.sort(function (a, b) {
        return new Date(a.measuredAt) - new Date(b.measuredAt);
    });

    statisticRows.forEach(function (row) {
        if (!row.building_key) return;
        const container = getBuildingStatisticContainer(
            state,
            row.building_key
        );
        const statistic = hydrateOnlineStatistic(row);

        state.knownBuildingKeys.add(row.building_key);

        if (row.day_type === "all" && row.time_slot === "all") {
            container.overall = statistic;
            container.latestObservedValue = statistic.lastObservedValue;
            container.latestObservedAt = statistic.lastObservedAt;
            return;
        }

        if (!container.byDayType[row.day_type]) {
            container.byDayType[row.day_type] = {};
        }
        container.byDayType[row.day_type][row.time_slot] = statistic;
    });
}

async function appendCrowdSnapshot(snapshot) {
    await fs.promises.appendFile(
        CROWD_SNAPSHOTS_PATH,
        snapshotToCsvRow(snapshot),
        "utf8"
    );
}

function statisticToCsvRow(
    buildingKey,
    dayType,
    timeSlot,
    statistic
) {
    return encodeCsvRow([
        buildingKey,
        dayType,
        timeSlot,
        statistic.count,
        statistic.mean,
        statistic.m2,
        statistic.lastObservedValue,
        statistic.lastObservedAt
    ]);
}

async function writeBuildingStatisticsCsv(state) {
    const rows = [encodeCsvRow(BUILDING_STATISTIC_HEADERS)];

    Object.entries(state.buildingStatistics).forEach(function (entry) {
        const buildingKey = entry[0];
        const container = entry[1];

        rows.push(statisticToCsvRow(
            buildingKey,
            "all",
            "all",
            container.overall
        ));

        Object.entries(container.byDayType).forEach(function (dayEntry) {
            const dayType = dayEntry[0];
            Object.entries(dayEntry[1]).forEach(function (slotEntry) {
                rows.push(statisticToCsvRow(
                    buildingKey,
                    dayType,
                    slotEntry[0],
                    slotEntry[1]
                ));
            });
        });
    });

    const temporaryPath = BUILDING_STATISTICS_PATH + ".tmp";
    await fs.promises.writeFile(temporaryPath, rows.join(""), "utf8");
    await fs.promises.rename(temporaryPath, BUILDING_STATISTICS_PATH);
}

async function persistCrowdObservation(crowdData, fetchedAt) {
    const result = saveCrowdObservation(
        crowdHistoryState,
        crowdData,
        fetchedAt
    );

    if (result.status === "duplicate") return result;

    await appendCrowdSnapshot(result.snapshot);
    await writeBuildingStatisticsCsv(crowdHistoryState);
    return result;
}

function enqueueCrowdObservation(crowdData, fetchedAt) {
    const operation = crowdWriteQueue.then(function () {
        return persistCrowdObservation(crowdData, fetchedAt);
    });

    crowdWriteQueue = operation.catch(function () {
        // 次回の保存処理を止めないため、キュー自体は復旧させる。
    });
    return operation;
}

async function collectCrowdObservation(at) {
    const targetTime = at || new Date();
    const params = new URLSearchParams({
        time: targetTime.toISOString()
    });
    const crowdData = await fetchJson(
        "https://api.dtc.wide.ad.jp/crowd?" + params.toString(),
        "キャンパス混雑情報"
    );

    return enqueueCrowdObservation(crowdData, new Date());
}

function scheduleNextCrowdCollection() {
    const remainder = Date.now() % CROWD_COLLECTION_INTERVAL_MS;
    const delay = remainder === 0
        ? CROWD_COLLECTION_INTERVAL_MS
        : CROWD_COLLECTION_INTERVAL_MS - remainder;

    crowdCollectionTimer = setTimeout(async function () {
        try {
            await collectCrowdObservation(new Date());
        } catch (error) {
            console.error("Wi-Fi接続数の定期取得に失敗しました。", error);
        } finally {
            scheduleNextCrowdCollection();
        }
    }, delay);
}

async function initializeCrowdPersistence() {
    await fs.promises.mkdir(CROWD_DATA_DIR, { recursive: true });
    await loadCrowdHistoryFromCsv(crowdHistoryState);

    try {
        await collectCrowdObservation(new Date());
    } catch (error) {
        console.error("初回のWi-Fi接続数取得に失敗しました。", error);
    }

    scheduleNextCrowdCollection();
}

function calculateCrowding(
    estimatedPopulation,
    transportCapacity,
    assumptions
) {
    const predictedDemand = Math.round(
        estimatedPopulation *
        assumptions.departureRate *
        assumptions.busUseRate *
        assumptions.routeShare
    );

    if (transportCapacity <= 0) {
        return {
            status: "unavailable",
            level: "unavailable",
            label: "算出不能",
            predictedDemand: predictedDemand,
            transportCapacity: transportCapacity,
            loadFactor: null,
            loadPercentage: null,
            excessDemand: null,
            assumptions: assumptions
        };
    }

    const loadFactor = predictedDemand / transportCapacity;
    let level;
    let label;

    if (loadFactor < 0.5) {
        level = "low";
        label = "空いています";
    } else if (loadFactor < 0.8) {
        level = "moderate";
        label = "やや混雑";
    } else if (loadFactor <= 1) {
        level = "crowded";
        label = "混雑";
    } else {
        level = "over_capacity";
        label = "非常に混雑";
    }

    return {
        status: "available",
        level: level,
        label: label,
        predictedDemand: predictedDemand,
        transportCapacity: transportCapacity,
        loadFactor: Number(loadFactor.toFixed(2)),
        loadPercentage: Math.round(loadFactor * 100),
        excessDemand: Math.max(
            predictedDemand - transportCapacity,
            0
        ),
        assumptions: assumptions
    };
}

function calculateInboundCrowding(
    wifiChange,
    transportCapacity,
    startTime,
    endTime
) {
    let windowMinutes =
        timeToMinutes(endTime) - timeToMinutes(startTime);

    if (windowMinutes <= 0) {
        windowMinutes += 24 * 60;
    }

    if (
        !wifiChange ||
        wifiChange.status !== "available" ||
        wifiChange.quality === "invalid" ||
        !Number.isFinite(wifiChange.estimatedPopulationDelta) ||
        !Number.isFinite(wifiChange.intervalMinutes) ||
        wifiChange.intervalMinutes <= 0
    ) {
        return {
            status: "unavailable",
            level: "unavailable",
            label: "算出待ち",
            predictedDemand: null,
            transportCapacity: transportCapacity,
            loadFactor: null,
            loadPercentage: null,
            excessDemand: null,
            source: "wifi_population_delta",
            reason: "wifi_delta_unavailable"
        };
    }

    const recentPopulationIncrease = Math.max(
        0,
        wifiChange.estimatedPopulationDelta
    );
    const arrivalRatePerMinute =
        recentPopulationIncrease / wifiChange.intervalMinutes;
    const predictedDemand = Math.round(
        arrivalRatePerMinute * windowMinutes
    );

    if (transportCapacity <= 0) {
        return {
            status: "unavailable",
            level: "unavailable",
            label: "算出不能",
            predictedDemand: predictedDemand,
            transportCapacity: transportCapacity,
            loadFactor: null,
            loadPercentage: null,
            excessDemand: null,
            source: "wifi_population_delta",
            reason: "transport_capacity_unavailable"
        };
    }

    const loadFactor = predictedDemand / transportCapacity;
    let level;
    let label;

    if (loadFactor < 0.5) {
        level = "low";
        label = "空いています";
    } else if (loadFactor < 0.8) {
        level = "moderate";
        label = "やや混雑";
    } else if (loadFactor <= 1) {
        level = "crowded";
        label = "混雑";
    } else {
        level = "over_capacity";
        label = "非常に混雑";
    }

    return {
        status: "available",
        level: level,
        label: label,
        predictedDemand: predictedDemand,
        transportCapacity: transportCapacity,
        loadFactor: Number(loadFactor.toFixed(2)),
        loadPercentage: Math.round(loadFactor * 100),
        excessDemand: Math.max(
            predictedDemand - transportCapacity,
            0
        ),
        source: "wifi_population_delta",
        assumptions: {
            recentPopulationIncrease: recentPopulationIncrease,
            observationMinutes: wifiChange.intervalMinutes,
            projectionWindowMinutes: Number(windowMinutes.toFixed(2)),
            arrivalRatePerMinute: Number(
                arrivalRatePerMinute.toFixed(2)
            )
        }
    };
}

function parseRate(value, defaultValue, name) {
    const rate = value === undefined ? defaultValue : Number(value);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
        const error = new Error(name + "は0から1の数値で指定してください。");
        error.status = 400;
        throw error;
    }
    return rate;
}

function parseNumberInRange(value, defaultValue, min, max, name) {
    const number = value === undefined ? defaultValue : Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
        const error = new Error(
            name + "は" + min + "から" + max + "の数値で指定してください。"
        );
        error.status = 400;
        throw error;
    }
    return number;
}

function parseDate(value) {
    if (value === undefined) return new Date();
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) {
        const error = new Error("atは有効な日時で指定してください。");
        error.status = 400;
        throw error;
    }
    return date;
}

async function fetchJson(url, label) {
    const response = await fetch(url);
    if (!response.ok) {
        const error = new Error(
            label + "の取得に失敗しました: HTTP " + response.status
        );
        error.status = 502;
        throw error;
    }
    return response.json();
}

function asyncRoute(handler) {
    return function (req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

app.get(
    "/getlecturesdata",
    asyncRoute(async function (req, res) {
        const date = req.query.date || getTokyoDateString(new Date());
        const params = new URLSearchParams({ date: String(date) });
        const data = await fetchJson(
            "https://api.dtc.wide.ad.jp/lectures?" + params.toString(),
            "授業情報"
        );
        res.json(data);
    })
);

app.get(
    "/getbusdata",
    asyncRoute(async function (req, res) {
        const params = new URLSearchParams({
            date: String(req.query.date || getTokyoDateString(new Date())),
            stopCode: String(req.query.stopCode || "23955"),
            destination: String(req.query.destination || "shonandai")
        });
        const data = await fetchJson(
            "https://api.dtc.wide.ad.jp/bus?" + params.toString(),
            "バス情報"
        );
        res.json(data);
    })
);

app.get(
    "/getinboundbusdata",
    asyncRoute(async function (req, res) {
        const date = String(
            req.query.date || getTokyoDateString(new Date())
        );
        const data = getInboundBusData(
            date,
            req.query.scheduleType
        );
        const busCounts = countBusesByRoute(data, "00:00", "23:59:59");
        const transport = calculateTransportCapacity(busCounts);

        res.json({
            ...data,
            countsByRoute: busCounts,
            transportCapacity: transport.totalCapacity,
            unknownCapacityRoutes: transport.unknownRoutes
        });
    })
);

/*
 * フロントが利用する統合API。
 * API取得、現在時限判定、人数推定、バス集計をすべてサーバーで行う。
 */
app.get(
    "/api/dashboard",
    asyncRoute(async function (req, res) {
        const now = parseDate(req.query.at);
        const date = String(req.query.date || getTokyoDateString(now));
        const stopCode = String(req.query.stopCode || "23955");
        const destination = String(req.query.destination || "shonandai");
        const defaultBusWindow = getDefaultBusWindow(now);
        const startTime = String(
            req.query.startTime || defaultBusWindow.start
        );
        const endTime = String(
            req.query.endTime || defaultBusWindow.end
        );
        const seatingRate = parseRate(
            req.query.seatingRate,
            0.6,
            "seatingRate"
        );
        // /crowd が滞在人数ベースの値を返すため、1人あたり端末数は1〜2に限定する。
        const devicesPerPerson = parseNumberInRange(
            req.query.devicesPerPerson,
            DEFAULT_DEVICES_PER_PERSON,
            1,
            2,
            "devicesPerPerson"
        );
        const departureRate = parseRate(
            req.query.departureRate,
            0.3,
            "departureRate"
        );
        const busUseRate = parseRate(
            req.query.busUseRate,
            0.45,
            "busUseRate"
        );
        const routeShare = parseRate(
            req.query.routeShare,
            1,
            "routeShare"
        );

        timeToMinutes(startTime);
        timeToMinutes(endTime);

        const lectureParams = new URLSearchParams({ date: date });
        const busParams = new URLSearchParams({
            date: date,
            stopCode: stopCode,
            destination: destination
        });
        const responses = await Promise.all([
            fetchJson(
                "https://api.dtc.wide.ad.jp/lectures?" +
                    lectureParams.toString(),
                "授業情報"
            ),
            fetchJson(
                "https://api.dtc.wide.ad.jp/bus?" + busParams.toString(),
                "バス情報"
            )
        ]);

        const lectureData = responses[0];
        const busData = responses[1];
        let currentSnapshot = crowdHistoryState.snapshots[
            crowdHistoryState.snapshots.length - 1
        ];

        if (!currentSnapshot) {
            const crowdObservation = await collectCrowdObservation(now);
            currentSnapshot = crowdObservation.snapshot;
        }

        const wifiChange = getCrowdDeltaForSnapshot(
            crowdHistoryState,
            currentSnapshot.measuredAt,
            devicesPerPerson
        );
        const inboundBusData = getInboundBusData(
            date,
            req.query.inboundScheduleType
        );
        const current = getCurrentClasses(lectureData.courses || [], now);
        const attendance = calculateCurrentAttendance(
            current.classes,
            seatingRate
        );
        const busCounts = countBusesByRoute(
            busData,
            startTime,
            endTime
        );
        const transport = calculateTransportCapacity(busCounts);
        const inboundBusCounts = countBusesByRoute(
            inboundBusData,
            startTime,
            endTime
        );
        const inboundTransport = calculateTransportCapacity(
            inboundBusCounts
        );
        const inboundCrowding = calculateInboundCrowding(
            wifiChange,
            inboundTransport.totalCapacity,
            startTime,
            endTime
        );
        const campusStock = estimateCampusPopulationFromSnapshot(
            currentSnapshot,
            { generatedAt: currentSnapshot.generatedAt },
            devicesPerPerson
        );
        const crowding = calculateCrowding(
            campusStock.estimatedPopulation,
            transport.totalCapacity,
            {
                departureRate: departureRate,
                busUseRate: busUseRate,
                routeShare: routeShare
            }
        );

        res.json({
            generatedAt: now.toISOString(),
            parameters: {
                date: date,
                stopCode: stopCode,
                destination: destination,
                seatingRate: seatingRate,
                devicesPerPerson: devicesPerPerson,
                departureRate: departureRate,
                busUseRate: busUseRate,
                routeShare: routeShare,
                busWindow: { start: startTime, end: endTime }
            },
            campusStock: campusStock,
            wifiChange: wifiChange,
            crowding: crowding,
            inboundCrowding: inboundCrowding,
            lectures: {
                currentPeriodCode: current.periodCode,
                currentPeriod: current.period,
                currentClasses: current.classes,
                estimatedAttendance: attendance.totalAttendance,
                countedRooms: attendance.countedRooms,
                unknownRooms: attendance.unknownRooms
            },
            buses: {
                countsByRoute: busCounts,
                nextBus: getNextBuses(busData, now),
                transportCapacity: transport.totalCapacity,
                unknownCapacityRoutes: transport.unknownRoutes
            },
            inboundBuses: {
                date: inboundBusData.date,
                scheduleType: inboundBusData.scheduleType,
                direction: inboundBusData.direction,
                countsByRoute: inboundBusCounts,
                nextBus: getNextBuses(inboundBusData, now),
                transportCapacity: inboundTransport.totalCapacity,
                unknownCapacityRoutes: inboundTransport.unknownRoutes
            }
        });
    })
);

function minutesToTime(minutes) {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    return String(hour).padStart(2, "0") + ":" +
        String(minute).padStart(2, "0");
}

async function getOutboundBusData(date) {
    const cached = outboundBusCache.get(date);
    if (cached && Date.now() - cached.fetchedAt < 60 * 60 * 1000) {
        return cached.data;
    }
    const params = new URLSearchParams({
        date: date,
        stopCode: "23955",
        destination: "shonandai"
    });
    const data = await fetchJson(
        "https://api.dtc.wide.ad.jp/bus?" + params.toString(),
        "バス情報"
    );
    outboundBusCache.set(date, { fetchedAt: Date.now(), data: data });
    return data;
}

/*
 * 予報した人数に現行の式を当てはめた、1時間ごとのバスの目安。
 * 帰り：人数 × 帰宅率 × バス利用率、来る：次の1時間の人数の増加分。
 */
async function getHourlyBusOutlook(date, forecastValues, bins) {
    if (!forecastValues) return null;

    let outboundData = null;
    try {
        outboundData = await getOutboundBusData(date);
    } catch (error) {
        console.error("バス情報の取得に失敗しました。", error);
    }
    const inboundData = getInboundBusData(date);

    function valueAt(minute) {
        const index = bins.indexOf(minute);
        return index >= 0 ? forecastValues[index] : null;
    }

    const rows = [];
    for (let hour = 7; hour <= 21; hour += 1) {
        const start = minutesToTime(hour * 60);
        const end = minutesToTime((hour + 1) * 60);
        const stock = [valueAt(hour * 60), valueAt(hour * 60 + 30)]
            .filter(function (v) { return v !== null; });
        if (stock.length === 0) continue;
        const population = Math.round(
            stock.reduce(function (a, b) { return a + b; }, 0) / stock.length
        );
        const nextValue = valueAt((hour + 1) * 60);
        const increase = nextValue === null
            ? null
            : nextValue - valueAt(hour * 60);

        const outboundCounts = outboundData
            ? countBusesByRoute(outboundData, start, end)
            : null;
        const outboundCapacity = outboundCounts
            ? calculateTransportCapacity(outboundCounts).totalCapacity
            : null;
        const inboundCounts = countBusesByRoute(inboundData, start, end);
        const inboundCapacity =
            calculateTransportCapacity(inboundCounts).totalCapacity;

        rows.push({
            hour: hour,
            population: population,
            toShonandai: outboundCounts
                ? {
                    buses: Object.values(outboundCounts).reduce(function (a, b) { return a + b; }, 0),
                    crowding: calculateCrowding(
                        population,
                        outboundCapacity,
                        DEFAULT_ASSUMPTIONS
                    )
                }
                : null,
            toSfc: increase === null
                ? null
                : {
                    buses: Object.values(inboundCounts).reduce(function (a, b) { return a + b; }, 0),
                    crowding: calculateInboundCrowding(
                        {
                            status: "available",
                            quality: "valid",
                            estimatedPopulationDelta: increase,
                            intervalMinutes: 60
                        },
                        inboundCapacity,
                        start,
                        end
                    )
                }
        });
    }

    return {
        assumptions: DEFAULT_ASSUMPTIONS,
        outboundAvailable: Boolean(outboundData),
        rows: rows
    };
}

function parseDateParam(value) {
    const date = String(value || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(new Date(date + "T12:00:00+09:00").getTime())) {
        const error = new Error("日付はYYYY-MM-DD形式で指定してください。");
        error.status = 400;
        throw error;
    }
    return date;
}

app.get(
    "/api/campus/overview",
    asyncRoute(async function (req, res) {
        const now = new Date();
        const overview = await campusForecaster.getOverview(now);
        const today = overview.days.find(function (day) {
            return day.date === overview.today;
        });
        overview.todayBus = await getHourlyBusOutlook(
            overview.today,
            today && today.forecast ? today.forecast.values : null,
            overview.bins
        );
        res.json(overview);
    })
);

app.get(
    "/api/campus/day/:date",
    asyncRoute(async function (req, res) {
        const date = parseDateParam(req.params.date);
        const day = await campusForecaster.getDay(date, new Date());
        day.bus = await getHourlyBusOutlook(
            date,
            day.forecast ? day.forecast.values : null,
            day.bins
        );
        res.json(day);
    })
);

/*
 * バス混雑の予報（別ページ）。キャンパス人数の予報とは
 * 「日付 → 30分ごとの人数」の受け渡しだけでつながる。
 */
const busForecaster = createBusForecaster({
    capacities: ROUTE_CAPACITIES,
    getCampusSeries: async function (date) {
        const day = await campusForecaster.getDay(date, new Date());
        return {
            bins: day.bins,
            forecast: day.forecast ? day.forecast.values : null,
            actual: day.actual,
            forecastInfo: day.forecast
                ? { basis: day.forecast.basis, issuedAt: day.forecast.issuedAt }
                : null,
            today: day.today,
            nowMinute: day.nowMinute,
            type: day.type,
            calendar: day.calendar
        };
    },
    getDepartures: async function (date, direction) {
        const data = direction === "to_sfc"
            ? getInboundBusData(date)
            : await getOutboundBusData(date);
        return (data.timetables || []).flatMap(function (timetable) {
            return timetable.departures || [];
        });
    }
});

app.get(
    "/api/bus/day/:date",
    asyncRoute(async function (req, res) {
        const date = parseDateParam(req.params.date);
        const busShare = parseRate(req.query.busShare, 0.45, "busShare");
        res.json(await busForecaster.getDay(date, { busShare: busShare }));
    })
);

app.get("/bus/:date", function (req, res) {
    res.sendFile(path.join(__dirname, "staticfile_public", "bus.html"));
});

app.get("/day/:date", function (req, res) {
    res.sendFile(path.join(__dirname, "staticfile_public", "index.html"));
});

app.use(function (error, req, res, next) {
    console.error(error);
    if (res.headersSent) {
        next(error);
        return;
    }
    res.status(error.status || 500).json({
        error: error.status ? error.message : "サーバーエラーが発生しました。"
    });
});

async function startServer() {
    await initializeCrowdPersistence();
    await campusForecaster.initialize();

    app.listen(port, function () {
        console.log("Server is running at http://localhost:" + port);
        console.log("Crowd CSV directory: " + CROWD_DATA_DIR);
    });
}

startServer().catch(function (error) {
    console.error("サーバーの初期化に失敗しました。", error);
    process.exitCode = 1;
});
