# Final Project Exploration 1

Sketches are drawn by hand on Procreate app (iPad).

### Domain
My domain ranges from question to question. I'd love to create an interactive visualization that tackles a real problem and question in the NYC area. My domains range from climate/public health, to AI & labor, to urban & economic geography. 

## Question 1: How is a changing/subtropical climate affecting different groups of New Yorkers?
### Idea
I thought of this idea because it seems like every year the weather in NYC is getting hotter and more humid. In comparison to my childhood, I can't recall the humidity in the summers being so unbearable. In 2020, NYC even transitioned into a sub-tropical climate.

I'd then like to explore how this idea is impacting different neighborghoods in terms of socioeconomic demographics as well as green spaces in NYC. 
### Related Work
[The NYC Heat Vulnerability Index](https://a816-dohbesp.nyc.gov/IndicatorPublic/data-features/hvi/?utm_source=chatgpt.com)
Expanding onto the NYC HVI, which is already an extensive data visualization project, I'd like to explore more neighborhood-specific components in creating the HVI score. The visualization currently does not offer this, instead giving a more high-level overview of components (green space, demographics) and only a HVI score when clicking into a neighborhood. Other changes I can replicate and explore are comparing HVI scores between neighborhoods, especially if they are the same but are impacted by different components. Finally, I am wondering if it is possible to collect data on time so that I can create an interactive time-series visualization. 
[2026 Heat-Related Mortality Report](https://a816-dohbesp.nyc.gov/IndicatorPublic/data-features/heat-report/)
### Potential Datasets
NYC Heat Vulnerability Index
NYC Climate Data
NYC Tree Census
NYC Parks and Open Data
NOAA Weather Data
### Rough Sketches
![alt text](image.png)

## Question 2: How is AI changing the skills employers want?
### Idea
AI is changing the skills, occupations, and qualifications that employers are looking for. As AI integrates into more jobs, it'll be interesting to see what employers are asking for. I wonder how this impacts different industries as well, not just tech and finance. Does AI even impact blue collar jobs? Are education requirements changing as well? I'd like to explore this for the NYC region as that is where I am applying for jobs and potentially expand it to compare nation-wide or region-wide (Northeast)
### Related Work
[Anthropic Economic Index](https://www.anthropic.com/economic-index#job-explorer)
### Potential Datasets
O*NET
Anthropic Data
OpenAI Data
NYC Jobs
U.S. Bureau of Labor Statistics
NYC Employment Data
### Rough Sketches
![alt text](image-1.png)

## Question 3: Are NYC neighborhoods becoming more commercially similar over time? Which neighborhoods are most impacted? Which business are disappearing or being replaced? 
### Idea
The "same-ification" is a phenomenon/trend that has recently gained traction. The idea is that NYC neighborhoods are becoming the same because popular independent spots have been scaling into mini-chains across NYC. Examples are Little Ruby's, 7th Street Burger, Pop-up Bagels, Blank Street, and more. As such, neighborhoods like Williamsburg and West Village feel the same with curated and uniform storefronts that have replaced the distinct characteristics that once were there. I'm especially interested in this idea because there is potentially in exploring marketing themes, looking at economic impacts, potentially socioeconomic demographics, while creating an interactive visualization. The "same-ificiation" of NYC is a topic that really came about this past year so it is incredibly relevant.
### Related Work
[Article](https://chefjesseconsulting.biz/blog/nyc-restaurant-same-ification)
[NYC Comptroller](https://comptroller.nyc.gov/reports/whos-minding-the-storefronts/?utm_source=chatgpt.com)
### Potential Datasets
NYC Opeen Data businesses
OpenStreetMap
Yelp
TikTok Data if possible - how does TikTok impact the same-ification?
Commercial rent data
Property values
Foot traffic/tourism
New construction, gentrification
### Rough Sketches
![alt text](image-2.png)


# Task Analysis

## Question 1: How is a changing/subtropical climate affecting different groups of New Yorkers?
I want to understand how changes in temperature, precipitation, and extreme weather are affecting neighborhoods and demographic groups in NYC. The visualization should ideally help users identify neighborhoods with the most climate-related changes, compare impacts across different socioeconomic factors. I want the visual to allow for comparison between 2 or more neighborhoods for more interactive eexploration.

## Question 2: How is AI changing the skills employers want?
I want to identify how skills requested by employers are evolving as AI is more heavily adopted. This may be through sifting through job portals and listings. Along with O*NET data on skillsets, the visualization should allow users to explore skill demands across industries and occupations during different time periods. This should help users see what occupations are impacted, how skill requirements are changing, and how they may want to respond to the changes.

## Question 3: Are NYC neighborhoods becoming more commercially similar over time? Which neighborhoods are most impacted? Which business are disappearing or being replaced? 
I want to explore how NYC neighborhoods are becoming more commercially similar over time and identify neighborhoods that are experiencing the most changes. The visualization will help users compare businesses across neighborhoods and time periods by identifying patterns of homogenization or diversification. This may be done by assigning scores based on what stores are in each neighborhood. Additionally, I will explore what types of businesses are opening, closing, or being replaced. Other areas to touch upon are if changes are in particular neighborhoods or periods of development, and where independent businesses face the most pressure.

# Validation Analysis

## Question 1: How is a changing/subtropical climate affecting different groups of New Yorkers?
### Domain Situation
The domain is how different demographic groups and neighborhoods across NYC are experiencing exposure and vulnerability to temperature change and extreme heat due to socioeconomic demographics, access to green spaces, and access to cooling infrastructure. Ideal users would be NYC residents, urban planners, environmental organizations (civic & industry), and policymakers who could use this tool in their research and decision making.
### Data/Task Abstraction
Tasks:
- Browse climate conditions across neighborhoods
- Compare climate conditions between neighborhoods
- Summarize climate and demographic/socioeconomic characteristics
- Identify neighborhoods with large changes in exposure
Data:
- Spatial data
- Quantitative data: temperature, heat exposure, green spaces, income, etc.
- Categorical data: demographic groups, census data, etc.
- Temporal data: climate measurements

### Visual Encoding/Interaction Idiom
A map-based visualization with interactive filtering and a time slider could support these tasks given the proper data. Color intensity could represent the climate exposure whilst a filtering system could let the user select demographic groups or other variables. A time slider would add a temporal element to the visualization whilst tooltips could help provide more information about neighborhoods or give statistics.

### Algorithm
The algorithm will have to efficiently update the visualization through the interactive features, which may be a big load due to reloading the map. Other algorithsm could be aggregateting data, normalizing variables, calculating climate exposure, and calculating changes between time.

## Question 2: How is AI changing the skills employers want?
### Domain Situation
For this visualization, users will need to be able to understand how employer demand for different skills is changing as AI is becoming more prevalent in the workspace. Target users would be students, unemployed people, workforce researchers, and hiring managers/recruiters.

### Data/Task Abstraction
Tasks:
- Browse skill demand across occupations.
- Compare skill demand between occupations and time.
- Identify increasing and decreasing skills.
- Summarize skill requirements.
- Track changes in skill demand over time.
Data:
- Quantitative: frequency of job postings that mention speciifc skills.
- Categorical: occupation, industry, skill categories
- Temporal: skill demand by year/month
- Relational: co-occurence between skills
### Visual Encoding/Interaction Idiom
For this visdualization, features that would be needed are how demand for skills change over time. Color could represent the magnitude of skill demand. The user should be able to filter for occupations, industries, or skill categories and hover over postings/skills to learn more about it. 
### Algorithm
The algorithm will need to be able to extract skills from job postings, standardize these skills and group them into categories. It will also need to be able to recompute results when users filter the data and calculate co-occurrence or other values neede for the visualization.

## Question 3: Are NYC neighborhoods becoming more commercially similar over time? Which neighborhoods are most impacted? Which business are disappearing or being replaced? 
### Domain Situation
For the final visual, users will be looking at how the composition of businesses in NYC neighborhoods change over time and whether neighborhoods are becoming more similar. Ideal users would then be NYC residents, urban researchers, community organizations, and city planners. 
### Data/Task Abstraction
Task:
- Compare the business composition of neighborhoods
- Browse commercial characteristics across NYC
- Identify neighborhoods with substantial change.
- Track changes in business composition over time.
- Summarize the composition of specific neighborhoods.
Data:
- Spatial: neighborhoods
- Categorical: business categories
- Quantitative: number of businesses and other metrics such as money, visitors, customers, etc.
- Temporal: businesses across years
- Relational: similarities between neighborhoods.
### Visual Encoding/Interaction Idiom
For this visual, it could be reprsented with an interatcive map along with a similarity matrix, or a visual that shows the business composition of neighborhoods. It should have a time filter, colors to differentiate business compositions, neighborhood selection, tooltips, etc.
### Algorithm
The algorithm would have to be able to ategorize businesses into standardized categories, convert neighborhoods into a business-category relation, calculate the pairwise similarity between neighborhoods, do this for different time periods, and identify businesses/categories/neighborhoods with substantial changes. This will need to be done for different filter settings.
