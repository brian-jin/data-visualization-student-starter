# Week 2 Datasets

## Overview

For week 2, I use two datasets: **Restaurant Grades** from NYC Open Data and a **GeoJSON file containing NYC borough boundaries** from the NYC Department of Health and Mental Hygiene's GitHub repository. As someone born and raised in NYC and a big foodie, I'm definitely drawn to the food scene, which is why I decided to explore these two datasets.

The Restaurant Grades dataset contains information about restaurant inspections and the grades assigned to restaurants based on their inspection results. The borough geography dataset provides the geographic boundaries of NYC's boroughs, which enables me to create a choropleth visual.

---

## Dataset 1: Restaurant Grades

**Source:** NYC Open Data, New York City Department of Health and Mental Hygiene

**Downloaded from:** [NYC Open Data – Restaurant Grades](https://data.cityofnewyork.us/Health/Restaurant-Grades/gra9-xbjk/about_data)

The overall concept of the dataset is to provide information about the health inspection and grading of restaurants in NYC, which can be used to examine differences in restaurant inspection outcomes across locations and over time.

### Attribute Analysis

| Attribute | Type | Description |
| --- | --- | --- |
| `DBA` | Categorical | The name of the restaurant. |
| `BORO` | Categorical | The borough where the restaurant is located. |
| `BUILDING` | Categorical | Building number associated with the restaurant's address. |
| `STREET` | Categorical | Street name of the restaurant's address. |
| `ZIPCODE` | Categorical | ZIP code associated with the restaurant's location. Categorical due to representing a geographic area rather than a measurable quantity. |
| `CUISINE DESCRIPTION` | Categorical | Type of cuisine served by the restaurant. |
| `VIOLATION DESCRIPTION` | Categorical | Description of the violation associated with an inspection. |
| `CRITICAL FLAG` | Categorical | Indicates whether a violation was considered critical. |
| `SCORE` | Quantitative | Numerical score assigned to the restaurant based on inspection results. |
| `GRADE` | Ordinal | Restaurant inspection grade, such as A, B, or C. |
| `GRADE DATE` | Numerical/Date | Date on which the restaurant received its inspection grade. Treated as a string in the frontend. |
| `RECORD DATE` | Numerical/Date | Date associated with the record in the dataset. Treated as a string in the frontend. |

---

## Dataset 2: NYC Borough Geography

**Source:** GitHub, NYC Department of Health and Mental Hygiene

**Downloaded from:** [NYC Geography – borough.geo.json](https://github.com/nycehs/NYC_geography/blob/master/borough.geo.json)

The overall concept of this dataset is to provide the spatial boundaries needed to display NYC boroughs on a map so that I can visualize the restaurant data.

### Attribute Analysis

The borough GeoJSON primarily consists of geographic features rather than a traditional table of observations and variables.

| Attribute | Type | Description |
| --- | --- | --- |
| `type` | Categorical | GeoJSON object type identifier ("Feature" for each entry, "FeatureCollection" for the wrapper). |
| `geometry.type` | Categorical | Geometry format identifier (consistently "MultiPolygon" for all 5 features) |
| `geometry.coordinates` | Spatial - Lat/Long | Nested arrays of [longitude, latitude] vertex pairs defining the polygon rings to create each borough's boundary |
| `geometry.BoroCode` | Categorical  | Numeric identifier for each borough (1–5). No meaningful rank order. |
| `geometry.BoroName` | Categorical | Name of the borough (Manhattan, Bronx, Brooklyn, Queens, Staten Island). |
