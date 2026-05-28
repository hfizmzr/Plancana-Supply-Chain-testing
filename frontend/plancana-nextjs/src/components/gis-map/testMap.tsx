"use client";

import React, { useEffect, useRef, useState } from "react";
import { loadModules } from "esri-loader";
import {
  MapPin,
  Factory,
  Truck,
  Store,
  CheckCircle,
  Filter,
  X,
  AlertCircle,
} from "lucide-react";
import { useDebounce } from "use-debounce";
import { batchService } from "@/services/api";
import { unique } from "next/dist/build/utils";
import { get } from "http";
import { parse } from "path";

interface MapProps {
  webMapId: any;
  dragable: any;
  height: string;
  zoom?: number;
  heatmap?: boolean;
  initialBatchId?: string;
  weatherwidget?: boolean;
}
function getRole(eventType: string): string {
  switch (eventType) {
    case "FARM_REGISTRATION":
    case "REGISTERED":
      return "FARMER";
    case "PROCESSING":
    case "PROCESSED":
      return "PROCESSOR";
    case "WAREHOUSE_ARRIVAL":
    case "DISTRIBUTION_ARRIVAL":
      return "DISTRIBUTOR";
    case "RETAIL_READY":
      return "RETAILER";
    default:
      return "OTHER";
  }
}

function iconToSvgString(
  IconComponent: any,
  color: string,
  size: number = 24,
  opacity: number = 1.0
) {
  const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" style="opacity: ${opacity};" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        ${getIconPath(IconComponent)}
      </svg>
    `;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function getIconPath(IconComponent: any) {
  switch (IconComponent) {
    case MapPin:
      return '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>';
    case Factory:
      return '<path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M17 18h1"/><path d="M12 18h1"/><path d="M7 18h1"/>';
    case Truck:
      return '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>';
    case Store:
      return '<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2v0a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12v0a2 2 0 0 1-2-2V7"/>';
    case CheckCircle:
      return '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>';
    default:
      return '<circle cx="12" cy="12" r="10"/>';
  }
}

const getConditionStatus = (temp: number, humidity: number) => {
  // GRADE C - High Spoilage Risk (>85% Hum OR >30°C Temp)
  if (humidity > 85 || temp > 30) {
    return {
      label: "High Spoilage Risk",
      color: "#ef4444",
      grade: "C",
      description: ": High moisture and heat detected.",
    };
  }

  // GRADE C - High Risk (75-85% Hum OR 25-30°C Temp)
  if (humidity >= 75 || temp >= 25) {
    return {
      label: "High Risk",
      color: "#f97316",
      grade: "C",
      description: ": Conditions favorable for degradation.",
    };
  }

  //  GRADE A - Optimal (65-72% Hum AND <25°C Temp)
  return {
    label: "Optimal",
    color: "#22c55e",
    grade: "A",
    description: ": Stable storage conditions.",
  };
};

const TestMap = ({
  webMapId,
  dragable,
  height,
  zoom,
  heatmap,
  weatherwidget,
  initialBatchId,
}: MapProps) => {
  const mapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<any>(null);
  const locationsLayerRef = useRef<any>(null);
  const routesLayerRef = useRef<any>(null);
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch] = useDebounce(searchTerm, 300);
  const [selectedBatchId, setSelectedBatchId] = useState<string>(
    initialBatchId || ""
  );
  const [isLocked, setIsLocked] = useState(!!initialBatchId);
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [showFilter, setShowFilter] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isHeatmapEnabled, setIsHeatmapEnabled] = useState(heatmap || false);
  const locationRendererRef = useRef<any>(null);

  useEffect(() => {
    setSelectedBatchId(debouncedSearch);
  }, [debouncedSearch]);

  // Helper function to map eventType to role
  const applyFilters = () => {
    const startTime = startDate ? new Date(startDate).getTime() : null;
    const endTime = endDate ? new Date(endDate).getTime() + 86400000 : null;

    if (!locationsLayerRef.current || !routesLayerRef.current) return;

    let expressions: string[] = [];

    if (selectedBatchId) {
      const parts = selectedBatchId.split("-");

      const batchExpressions: string[] = [];

      batchExpressions.push(`batchId = '${selectedBatchId}'`);

      for (let i = 3; i < parts.length; i++) {
        const ancestorBatch = parts.slice(0, i).join("-");
        batchExpressions.push(
          `(batchId = '${ancestorBatch}' AND isParentPath = 'true' AND timestampNum <= splitTimestamp)`
        );
      }

      expressions.push(`(${batchExpressions.join(" OR ")})`);
    }

    if (startDate) expressions.push(`timestampNum >= ${startTime}`);
    if (endDate) expressions.push(`timestampNum <= ${endTime}`);

    const finalExpression =
      expressions.length > 0 ? expressions.join(" AND ") : "1=1";
    console.log("Applying filter expression:", finalExpression); // Debug log

    locationsLayerRef.current.definitionExpression = finalExpression;

    routesLayerRef.current.graphics.forEach((graphic: any) => {
      const attr = graphic.attributes;
      let isPathValid = true;

      if (selectedBatchId) {
        const isDirectBatch = attr.batchIdName === selectedBatchId;

        const isAncestor =
          selectedBatchId.startsWith(attr.batchIdName + "-") &&
          attr.isParentPath === true;

        const isValidParentPath =
          isAncestor &&
          attr.splitTimestamp != null &&
          attr.timestamp != null &&
          attr.timestamp <= attr.splitTimestamp;

        isPathValid = isDirectBatch || isValidParentPath;
      } else {
        isPathValid = attr.isParentPath !== true;
      }

      const afterStart =
        !startTime || !attr.timestamp || attr.timestamp >= startTime;
      const beforeEnd =
        !endTime || !attr.timestamp || attr.timestamp <= endTime;

      graphic.visible = isPathValid && afterStart && beforeEnd;
    });

    // Force layer refresh
    if (locationsLayerRef.current) {
      locationsLayerRef.current.refresh();
    }
  };

  const clearFilters = () => {
    setSelectedBatchId("");
    setStartDate("");
    setEndDate("");
  };
  useEffect(() => {
    if (initialBatchId) {
      setSelectedBatchId(initialBatchId);
      setIsLocked(true);
    }

    console.log("selectedBatchId :", selectedBatchId);
  }, [initialBatchId]);

  if (initialBatchId) {
    applyFilters();
  }

  useEffect(() => {
    applyFilters();
  }, [selectedBatchId, startDate, endDate]);

  // Fetch token with retry and error handling
  async function fetchToken(retryCount = 0): Promise<string | null> {
    const MAX_RETRIES = 3;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch("/api/refresh-token", {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`Token fetch failed: ${res.status}`);
      }

      const data = await res.json();

      if (!data.access_token) {
        throw new Error("No access token in response");
      }

      return data.access_token;
    } catch (error) {
      console.error(`Token fetch attempt ${retryCount + 1} failed:`, error);

      if (retryCount < MAX_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, 2000 * (retryCount + 1))
        );
        return fetchToken(retryCount + 1);
      }

      setMapError(
        "Failed to authenticate with ArcGIS. Please refresh the page."
      );
      return null;
    }
  }

  // Initialize token with proper error handling
  useEffect(() => {
    let isMounted = true;
    let refreshInterval: NodeJS.Timeout;

    async function initTokenCycle() {
      const newToken = await fetchToken();

      if (!isMounted) return;

      if (newToken) {
        setToken(newToken);
        setMapError(null);

        // Refresh token every 55 minutes
        refreshInterval = setInterval(async () => {
          const refreshed = await fetchToken();
          if (isMounted && refreshed) {
            setToken(refreshed);
          }
        }, 55 * 60 * 1000);
      }
    }

    initTokenCycle();

    return () => {
      isMounted = false;
      if (refreshInterval) {
        clearInterval(refreshInterval);
      }
    };
  }, []);

  // Initialize map only when token is available
  useEffect(() => {
    if (!token || !mapRef.current) return;

    let view: any;
    let isMounted = true;

    setIsLoading(true);
    setMapError(null);

    loadModules(
      [
        "esri/views/MapView",
        "esri/WebMap",
        "esri/Graphic",
        "esri/layers/GraphicsLayer",
        "esri/layers/FeatureLayer",
        "esri/geometry/Point",
        "esri/widgets/Legend",
        "esri/identity/IdentityManager",
        "esri/renderers/UniqueValueRenderer",
        "esri/config",
      ],
      { css: true }
    )
      .then(
        ([
          MapViewModule,
          WebMapModule,
          GraphicModule,
          GraphicsLayerModule,
          FeatureLayerModule,
          PointModule,
          LegendModule,
          IdentityManager,
          UniqueValueRendererModule,
          esriConfig,
        ]: any[]) => {
          if (!isMounted) return;
          const orgUrl = "https://hafiz-sandbox.maps.arcgis.com";
          esriConfig.portalUrl = orgUrl;

          // Configure ArcGIS with token
          try {
            IdentityManager.registerToken({
              server: `${orgUrl}/sharing/rest`,
              token: token,
              expires: Date.now() + 55 * 60 * 1000,
            });

            // Note: When using OAuth tokens, don't set API key as they conflict
            // Only use API key OR OAuth token, not both
            // if (process.env.NEXT_PUBLIC_ARCGIS_API_KEY) {
            //   esriConfig.apiKey = process.env.NEXT_PUBLIC_ARCGIS_API_KEY;
            // }
          } catch (error) {
            console.error("Token registration error:", error);
            setMapError(
              "Authentication failed. Please check your credentials."
            );
            setIsLoading(false);
            return;
          }

          const Graphic = GraphicModule;
          const FeatureLayer = FeatureLayerModule;
          const UniqueValueRenderer = UniqueValueRendererModule;

          const size = 20;

          // Create renderer for location types
          const locationRenderer = new UniqueValueRenderer({
            field: "role",
            defaultLabel: "Other",
            legendOptions: {
              title: " ",
            },
            uniqueValueInfos: [
              {
                value: "FARMER",
                symbol: {
                  type: "picture-marker",
                  url: iconToSvgString(MapPin, "#228B22", size, 1.0),
                  width: `${size}px`,
                  height: `${size}px`,
                },
                label: "Farmer",
              },
              {
                value: "PROCESSOR",
                symbol: {
                  type: "picture-marker",
                  url: iconToSvgString(Factory, "#C86400", size, 1.0),
                  width: `${size}px`,
                  height: `${size}px`,
                },
                label: "Processor",
              },
              {
                value: "DISTRIBUTOR",
                symbol: {
                  type: "picture-marker",
                  url: iconToSvgString(Store, "#0032C8", size, 1.0),
                  width: `${size}px`,
                  height: `${size}px`,
                },
                label: "Distributor",
              },
              {
                value: "RETAILER",
                symbol: {
                  type: "picture-marker",
                  url: iconToSvgString(CheckCircle, "#B40000", size, 1.0),
                  width: `${size}px`,
                  height: `${size}px`,
                },
                label: "Retailer",
              },
            ],
          });

          locationRendererRef.current = locationRenderer;

          // Create feature layers
          const locationsLayer = new FeatureLayer({
            title: "Batch Locations",
            source: [],
            objectIdField: "ObjectID",
            spatialReference: { wkid: 4324 },
            fields: [
              { name: "ObjectID", type: "oid" },
              { name: "role", type: "string" },
              { name: "eventType", type: "string" },
              { name: "batchId", type: "string" },
              { name: "status", type: "string" },
              { name: "cropType", type: "string" },
              { name: "productType", type: "string" },
              { name: "quantity", type: "string" },
              { name: "location", type: "string" },
              { name: "tempDisplay", type: "string" },
              { name: "humDisplay", type: "string" },
              { name: "weather_main", type: "string" },
              { name: "weather_desc", type: "string" },
              { name: "timestamp", type: "string" },
              { name: "timestampNum", type: "double" },
              { name: "isParentPath", type: "string" },
              { name: "splitTimestamp", type: "double" },
              { name: "parentBatch", type: "string" },
              { name: "weatherRisk", type: "string" },
              { name: "weatherColor", type: "string" },
              { name: "weatherRiskDesc", type: "string" },
              { name: "riskValue", type: "double" },
              { name: "blockchain_txId", type: "string" },
              { name: "blockchain_verifiedBy", type: "string" },
            ],
            renderer: isHeatmapEnabled
              ? {
                  type: "heatmap",
                  field: "riskValue",
                  colorStops: [
                    { color: "rgba(0, 0, 0, 0)", ratio: 0 },
                    { color: "rgba(34, 197, 94, 0.3)", ratio: 0.1 },
                    { color: "rgba(34, 197, 94, 0.4)", ratio: 0.3 },
                    { color: "rgba(234, 179, 8, 0.6)", ratio: 0.5 },
                    { color: "rgba(249, 115, 22, 0.8)", ratio: 0.7 },
                    { color: "rgba(239, 68, 68, 1)", ratio: 0.9 },
                    { color: "rgba(220, 38, 38, 1)", ratio: 1.0 },
                  ],
                  maxDensity: 0.008,
                  minDensity: 0,
                  radius: 45,
                  blurRadius: 10,
                }
              : locationRenderer,
            geometryType: "point",
            popupEnabled: true,
            popupTemplate: {
              title: "{expression/dynamic-title}",
              content: `
              <div style="background-color:{weatherColor}; color:white; padding:10px; margin-bottom:10px; border-radius:4px; text-align:center; font-weight:bold;">
                {weatherRisk}: {weatherRiskDesc}
              </div>
              
              <div style="margin-bottom: 10px; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px; background-color: #f8fafc;">
                <div style="display: flex; align-items: center; margin-bottom: 5px;">
                  <span style="font-weight: bold; color: {expression/bc-color};">
                    {expression/bc-status}
                  </span>
                </div>
              </div>

              <div style="padding: 5px;">
                <b>Current Status:</b> {status}<br>
                <hr>
                <b>Environmental Conditions:</b><br>
                <span style="font-size: 1.1em;">🌡️ <b>Temp:</b> {tempDisplay}</span><br>
                <span style="font-size: 1.1em;">💧 <b>Humidity:</b> {humDisplay}</span><br>
                <b>Weather:</b> {weather_main} ({weather_desc})<br>
                <hr>
                <b>Product Details:</b><br>
                <b>Crop:</b> {cropType} ({productType})<br>
                <b>Quantity:</b> {quantity}<br>
                <b>Location:</b> {location}<br>
                <b>Time:</b> {timestamp}
              </div>
            `,
              expressionInfos: [
                {
                  name: "dynamic-title",
                  expression: `
              if ($feature.isParentPath == 'true' && !IsEmpty($feature.parentBatch)) {
                return "Parent Batch: " + $feature.parentBatch;
              } else {
                return "Batch: " + $feature.batchId;
              }
            `,
                },
                {
                  name: "bc-status",
                  expression: `
              if (!IsEmpty($feature.blockchain_txId)) {
                return "✓ Blockchain Verified";
              }
              return "Database Record Only";
            `,
                },
                {
                  name: "bc-color",
                  expression: `
                if (!IsEmpty($feature.blockchain_txId)) { return "#16a34a"; }
                return "#ca8a04";
              `,
                },
              ],
            },
          });

          const routesGraphicsLayer = new GraphicsLayerModule({
            title: "Route Lines",
          });
          IdentityManager.useSignInPage = false;
          // Create WebMap with error handling
          const map = new WebMapModule({
            portalItem: {
              id: webMapId || "a24b5bc059d2478e843f4c1968e47860", // Your ID from the screenshot
              portal: {
                url: orgUrl,
              },
            },
            layers: [routesGraphicsLayer, locationsLayer],
          });

          locationsLayerRef.current = locationsLayer;
          routesLayerRef.current = routesGraphicsLayer;
          locationsLayerRef.current.spatialReference = { wkid: 4326 };

          // Handle map load errors
          map.load().catch((error: any) => {
            console.error("WebMap load error:", error);
            console.error("DEBUG - Full Error Object:", error);
            console.error("DEBUG - Error Name:", error.name);
            console.error("DEBUG - Error Details:", error.details);
            if (!isMounted) return;

            if (
              error.message?.includes("403") ||
              error.message?.includes("401")
            ) {
              setMapError(
                "Access denied. Please check your ArcGIS credentials."
              );
            } else if (error.message?.includes("404")) {
              setMapError("Map not found. Please check the Web Map ID.");
            } else {
              setMapError("Failed to load map. Please refresh and try again.");
            }
            setIsLoading(false);
          });

          const view = new MapViewModule({
            container: mapRef.current,
            map: map,
            center: [102.591212, 2.767333],
            zoom: zoom || 6,
          });

          viewRef.current = view;

          view
            .when()
            .then(() => {
              if (!isMounted) return;

              setIsLoading(false);

              // Add legend
              Promise.all([
                locationsLayer.when(),
                routesGraphicsLayer.when(),
              ]).then(() => {
                if (!isMounted) return;

                const legend = new LegendModule({
                  view: view,
                  layerInfos: [
                    {
                      layer: locationsLayer,
                      title: " ", // Empty title saves space on mobile
                      hideLayers: false,
                    },
                  ],
                  style: "stacked", // Changed from "card" to "stacked"
                  respectLayerVisibility: true,
                });
                view.ui.add(legend, "top-right");
              });

              // Fetch and display data
              Promise.all([
                locationsLayer.when(),
                routesGraphicsLayer.when(),
              ]).then(() => {
                if (!isMounted) return;

                batchService
                  .getBatchesWithLineage()
                  .then((response) => {
                    if (!isMounted) return;

                    // Axios returns the data in response.data
                    const data = response.data;
                    const batchesData = data.batchesData || [];

                    // Update state and map markers
                    const uniqueBatchIds = Array.from(
                      new Set(batchesData.map((batch: any) => batch.batchId))
                    ) as string[];
                    setBatchIds(uniqueBatchIds);

                    const locationFeatures: any[] = [];
                    const routeFeatures: any[] = [];
                    let objectId = 1;

                    batchesData.forEach((batch: any) => {
                      const batchId = batch.batchId;

                      batch.historyPoints.forEach((pointData: any) => {
                        const point = new PointModule({
                          longitude: pointData.longitude,
                          latitude: pointData.latitude,
                        });
                        const temp =
                          parseFloat(pointData.metadata.temperature) || 0;
                        const hum =
                          parseFloat(pointData.metadata.humidity) || 0;
                        const condition = getConditionStatus(temp, hum);
                        const role = getRole(pointData.eventType);
                        const timestamp = new Date(
                          pointData.timestamp
                        ).getTime();
                        const riskScore =
                          condition.grade === "C"
                            ? 100
                            : condition.grade === "B"
                            ? 50
                            : 10;

                        locationFeatures.push({
                          geometry: point,
                          attributes: {
                            ObjectID: objectId++,
                            role: role,
                            eventType: pointData.eventType,
                            batchId: batchId,
                            status: batch.status,
                            cropType: batch.cropType,
                            productType: batch.productType,
                            quantity: batch.quantity,
                            location: pointData.metadata.location || "N/A",
                            weatherRisk: condition.label,
                            weatherColor: condition.color,
                            riskValue: riskScore,
                            tempDisplay: temp ? `${temp}°C` : "N/A",
                            humDisplay: hum ? `${hum}%` : "N/A",
                            weather_main:
                              pointData.metadata.weather_main || "N/A",
                            weather_desc:
                              pointData.metadata.weather_desc || "N/A",
                            timestamp: new Date(
                              pointData.timestamp
                            ).toLocaleString(),
                            splitTimestamp:
                              pointData.metadata.splitTimestamp || 0,
                            timestampNum: new Date(
                              pointData.timestamp
                            ).getTime(),
                            isParentPath: pointData.metadata?.isParentPath
                              ? "true"
                              : "false",
                            parentBatch:
                              pointData.metadata?.parentBatch || null,
                            weatherRiskDesc: condition.description || "N/A",
                            blockchain_txId:
                              pointData.metadata.blockchain?.txId || "",
                            blockchain_verifiedBy:
                              pointData.metadata.blockchain?.verifiedBy || "",
                          },
                        });
                      });

                      batch.activeRoutes.forEach((route: any) => {
                        const arrivalPoint = batch.historyPoints.find(
                          (p: any) =>
                            new Date(p.timestamp).getTime() >=
                            new Date(route.timestamp).getTime()
                        );
                        const temp = arrivalPoint
                          ? parseFloat(arrivalPoint.metadata.temperature)
                          : 0;
                        const hum = arrivalPoint
                          ? parseFloat(arrivalPoint.metadata.humidity)
                          : 0;
                        // 2. Determine Risk Level
                        let routeColor = [34, 197, 94, 1]; // Default Green (Optimal/Grade A)
                        let strokeWidth = 3;
                        let strokeStyle = "solid";

                        if (hum > 85 || temp > 30) {
                          routeColor = [220, 38, 38, 1]; // Bright Red
                          strokeWidth = 3;
                          strokeStyle = "dash";
                        } else if (
                          (hum >= 75 && hum <= 85) ||
                          (temp >= 25 && temp <= 30)
                        ) {
                          // Grade C
                          routeColor = [249, 115, 22, 1]; // Orange
                          strokeWidth = 3;
                        } else if (hum >= 65 && hum <= 72 && temp < 25) {
                          // Grade A - Optimal
                          routeColor = [34, 197, 94, 1]; // Green
                          strokeWidth = 3;
                        } else if (hum >= 55 && hum <= 60 && temp < 25) {
                          // Grade B
                          routeColor = [234, 179, 8, 1]; // Yellow/Gold
                          strokeWidth = 3;
                        } else {
                          // Conditions outside specific thesis brackets
                          routeColor = [148, 163, 184, 1]; // Gray (Unknown/Neutral)
                          strokeWidth = 2;
                        }

                        if (route.routePolyline) {
                          try {
                            const geojson = JSON.parse(route.routePolyline);
                            const polyline = {
                              type: "polyline",
                              paths: geojson.coordinates,
                            };
                            const routeSymbol = {
                              type: "simple-line",
                              color: routeColor, // change route colour here
                              width: strokeWidth,
                              style: strokeStyle,
                            };

                            const routeGraphic = new Graphic({
                              geometry: polyline,
                              symbol: routeSymbol,
                              attributes: {
                                batchIdName: route.isParentPath
                                  ? route.batchIdName
                                  : batch.batchId,
                                isParentPath: route.isParentPath ? true : false,
                                splitTimestamp: route.splitTimestamp || 0,
                                timestamp: route.timestamp || 0,
                                TotalTime: route.TotalTime,
                                distance: route.distance,
                                eta: route.estimatedTime,
                                riskLevel: temp
                                  ? getConditionStatus(temp, hum).label
                                  : "Unknown",
                                tempAtArrival: temp || "N/A",
                              },
                              popupTemplate: {
                                title: "Transport Route: {batchIdName}",
                                content: `
                                  <b>Distance:</b> {distance} km<br>
                                  <b>ETA between points:</b> {eta} minutes<br>
                                `,
                              },
                            });

                            if (routesLayerRef.current) {
                              routesLayerRef.current.add(routeGraphic);
                            }
                          } catch (e) {
                            console.error("Error parsing route geometry:", e);
                          }
                        }
                      });
                    });
                    if (locationFeatures.length > 0) {
                      locationsLayer.applyEdits({
                        addFeatures: locationFeatures,
                      });
                    }

                    if (routeFeatures.length > 0) {
                      routesGraphicsLayer.applyEdits({
                        addFeatures: routeFeatures,
                      });
                    }
                  })
                  .catch((err) => {
                    console.error("Error fetching batch data:", err);
                    if (isMounted) {
                      setMapError("Failed to load batch data.");
                    }
                  });
              });

              view.ui.components = [];
              if (dragable) {
                view.navigation.mouseWheelZoomEnabled = false;
                view.navigation.browserTouchPanEnabled = false;
                view.navigation.keyboardNavigationEnabled = false;
                view.on("drag", function (event: any) {
                  event.stopPropagation();
                });
              }
            })
            .catch((error: any) => {
              console.error("View initialization error:", error);
              if (isMounted) {
                setMapError("Failed to initialize map view.");
                setIsLoading(false);
              }
            });
        }
      )
      .catch((error) => {
        console.error("Map Module Load Error:", error);
        if (isMounted) {
          setMapError("Failed to load map modules. Please refresh.");
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [webMapId, token, dragable, zoom]);

  useEffect(() => {
    if (locationsLayerRef.current) {
      if (isHeatmapEnabled) {
        locationsLayerRef.current.renderer = {
          type: "heatmap",
          field: "riskValue",
          colorStops: [
            { color: "rgba(0, 0, 0, 0)", ratio: 0 }, // Transparent (no data)
            { color: "rgba(34, 197, 94, 0.3)", ratio: 0.1 }, // Faint green (Low risk - value 10)
            { color: "rgba(34, 197, 94, 0.4)", ratio: 0.3 }, // Green (Low risk)
            { color: "rgba(234, 179, 8, 0.6)", ratio: 0.5 }, // Yellow (Medium risk - value 50)
            { color: "rgba(249, 115, 22, 0.8)", ratio: 0.7 }, // Orange (High risk)
            { color: "rgba(239, 68, 68, 1)", ratio: 0.9 }, // Red (Very high risk)
            { color: "rgba(220, 38, 38, 1)", ratio: 1.0 }, // Bright RED (Critical - value 100)
          ],
          maxDensity: 0.008,
          minDensity: 0,
          radius: 45,
          blurRadius: 10,
        };
      } else {
        locationsLayerRef.current.renderer = locationRendererRef.current;
      }
      locationsLayerRef.current.refresh();
    }
  }, [isHeatmapEnabled]);

  useEffect(() => {
    const style = document.createElement("style");
    style.innerHTML = `
    /* 1. LAYER PRIORITY: Bring ArcGIS UI components to the absolute front */
    .esri-ui, 
    .esri-ui-corner, 
    .esri-ui-inner-container, 
    .esri-view-user-interface {
      z-index: 50 !important;
    }

    /* 2. POPUP PRIORITY: Ensure the waypoint info box is always on top */
    .esri-popup, 
    .esri-popup__main-container {
      z-index: 100 !important;
    }

    /* 3. MOBILE LEGEND SIZING (431px and below) */
    @media (max-width: 431px) {
      .esri-ui-top-right .esri-component.esri-legend {
        width: 130px !important;
        min-width: 130px !important;
        z-index: 60 !important; 
      }
      .esri-legend__service-label { font-size: 10px !important; padding: 4px !important; }
      .esri-legend__symbol { width: 12px !important; height: 12px !important; }
      .esri-legend__label { font-size: 9px !important; line-height: 1.2 !important; }
      .esri-legend__layer-table { margin-bottom: 2px !important; }
    }
  `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  const WeatherLegend = () => (
    <div
      className="absolute bottom-10 left-4 z-[10] bg-white/95 backdrop-blur-sm 
    p-5 max-[431px]:p-3 
    rounded-lg shadow-2xl border border-gray-200 
    max-w-[220px] max-[431px]:w-48"
    >
      <div className="flex items-center gap-2.5 max-[431px]:gap-2 mb-4 max-[431px]:mb-3 border-b pb-2.5 max-[431px]:pb-2">
        <AlertCircle
          size={22}
          className="text-blue-600 max-[431px]:w-4 max-[431px]:h-4"
        />
        <h3 className="font-bold text-base text-gray-800 max-[431px]:text-[12px]">
          Quality Risk Legend
        </h3>
      </div>

      <div className="space-y-4 max-[431px]:space-y-2">
        {[
          {
            color: "#ef4444",
            label: "High Spoilage",
            detail: ">85% H / >30°C | EMC >17",
          },
          {
            color: "#f97316",
            label: "High Risk",
            detail: "75-85% H / 25-30°C | EMC 15-17%",
          },
          {
            color: "#22c55e",
            label: "Optimal",
            detail: "65-72% H / <25°C | EMC 13-14.5%",
          },
          {
            color: "#eab308",
            label: "Warning",
            detail: "55-60% H / <25°C | EMC ~12%",
          },
        ].map((item) => (
          <div
            key={item.label}
            className="flex items-start gap-4 max-[431px]:gap-3"
          >
            <div
              className="w-10 h-1.5 mt-2 max-[431px]:w-5 max-[431px]:h-1.5 max-[431px]:mt-1.5 rounded-sm"
              style={{ backgroundColor: item.color }}
            ></div>
            <div>
              <p className="text-sm font-bold text-gray-800 max-[431px]:text-[11px] leading-tight">
                {item.label}
              </p>
              <p className="text-xs text-gray-500 max-[431px]:text-[9px] leading-tight mt-0.5">
                {item.detail}
              </p>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 max-[431px]:mt-2 text-[10px] max-[431px]:text-[8px] text-gray-400 italic">
        *EMC standard D245.
      </p>
    </div>
  );
  return (
    <>
      <div className="relative w-full" style={{ height: height }}>
        {/* Error Display */}
        {mapError && (
          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-20 bg-red-50 border border-red-200 rounded-lg p-4 shadow-lg max-w-md">
            <div className="flex items-start gap-3">
              <AlertCircle
                className="text-red-600 flex-shrink-0 mt-0.5"
                size={20}
              />
              <div>
                <h4 className="font-semibold text-red-900 mb-1">Map Error</h4>
                <p className="text-sm text-red-700">{mapError}</p>
                <button
                  onClick={() => window.location.reload()}
                  className="mt-2 text-sm text-red-600 hover:text-red-800 font-medium underline"
                >
                  Refresh Page
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Loading Indicator */}
        {isLoading && !mapError && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-600 font-medium">Loading map...</p>
            </div>
          </div>
        )}

        {!isLocked && (
          <div className="relative">
            <button
              onClick={() => setShowFilter(!showFilter)}
              className="absolute top-4 left-4 z-10 bg-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 hover:bg-gray-50 transition-colors"
            >
              <Filter size={18} />
              <span className="font-medium">Filters</span>
              {(selectedBatchId || startDate || endDate) && (
                <span className="bg-blue-500 text-white text-xs px-2 py-0.5 rounded-full">
                  Active
                </span>
              )}
            </button>
            {showFilter && (
              <div className="absolute top-16 left-4 z-10 bg-white p-4 rounded-lg shadow-xl w-80">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-lg">Filter Options</h3>
                  <button
                    onClick={() => setShowFilter(false)}
                    className="text-gray-500 hover:text-gray-700"
                  >
                    <X size={20} />
                  </button>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Search Batch ID
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        placeholder="Type to search batch..."
                        value={selectedBatchId}
                        onChange={(e) =>
                          setSelectedBatchId(e.target.value.toUpperCase())
                        }
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />

                      {selectedBatchId &&
                        !batchIds.includes(selectedBatchId) && (
                          <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-xl max-h-40 overflow-y-auto">
                            {batchIds
                              .filter((id) => id.includes(selectedBatchId))
                              .map((id) => (
                                <button
                                  key={id}
                                  onClick={() => setSelectedBatchId(id)}
                                  className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 hover:text-blue-700 transition-colors border-b border-gray-50 last:border-0"
                                >
                                  <span className="font-medium">{id}</span>
                                </button>
                              ))}
                          </div>
                        )}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Start Date
                    </label>
                    <input
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      End Date
                    </label>
                    <input
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  {(selectedBatchId || startDate || endDate) && (
                    <button
                      onClick={clearFilters}
                      className="w-full px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors font-medium"
                    >
                      Clear All Filters
                    </button>
                  )}
                  <button
                    onClick={() => setIsHeatmapEnabled(!isHeatmapEnabled)}
                    className={`w-full px-4 py-2 mt-2 rounded-md transition-colors font-medium ${
                      isHeatmapEnabled
                        ? "bg-red-500 text-white"
                        : "bg-blue-600 text-white"
                    }`}
                  >
                    {isHeatmapEnabled
                      ? "View Individual Batches"
                      : "Show Quality Hotspots (Heatmap)"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {!isLoading && !mapError && weatherwidget && <WeatherLegend />}
        {/* Map Container */}
        <div
          ref={mapRef}
          className="map-view-container"
          style={{ height: height, width: "100%" }}
        />
      </div>
    </>
  );
};

export default TestMap;
