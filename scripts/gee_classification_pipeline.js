var aoi = ee.Geometry.Rectangle([89.48, 22.75, 89.62, 22.9]);

Map.centerObject(aoi, 13);

// 2. Cloud Masking Functions
function prepL8(img) {
  var qa = img.select('QA_PIXEL');
  var mask = qa
    .bitwiseAnd(1 << 1)
    .eq(0)
    .and(qa.bitwiseAnd(1 << 2).eq(0))
    .and(qa.bitwiseAnd(1 << 3).eq(0))
    .and(qa.bitwiseAnd(1 << 4).eq(0));
  var optical = img.select('SR_B.*').multiply(0.0000275).add(-0.2);
  return optical
    .updateMask(mask)
    .select(
      ['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'],
      ['blue', 'green', 'red', 'nir', 'swir1', 'swir2']
    );
}

function prepL5L7(img) {
  var qa = img.select('QA_PIXEL');
  var mask = qa
    .bitwiseAnd(1 << 3)
    .eq(0)
    .and(qa.bitwiseAnd(1 << 4).eq(0));
  var optical = img.select('SR_B.*').multiply(0.0000275).add(-0.2);
  return optical
    .updateMask(mask)
    .select(
      ['SR_B1', 'SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B7'],
      ['blue', 'green', 'red', 'nir', 'swir1', 'swir2']
    );
}

// 3. Spectral Indices
function addIndicesAndTexture(img) {
  var ndvi = img.normalizedDifference(['nir', 'red']).rename('NDVI');
  var ndbi = img.normalizedDifference(['swir1', 'nir']).rename('NDBI');
  var mndwi = img.normalizedDifference(['green', 'swir1']).rename('MNDWI');
  var bui = ndbi.subtract(ndvi).rename('BUI');
  var lswi = img.normalizedDifference(['nir', 'swir1']).rename('LSWI');
  var ndti = img.normalizedDifference(['swir1', 'swir2']).rename('NDTI');
  var bsi = img
    .expression(
      '((SWIR1 + RED) - (NIR + BLUE)) / ((SWIR1 + RED) + (NIR + BLUE))',
      {
        SWIR1: img.select('swir1'),
        RED: img.select('red'),
        NIR: img.select('nir'),
        BLUE: img.select('blue'),
      }
    )
    .rename('BSI');
  return img.addBands([ndvi, ndbi, mndwi, lswi, bui, bsi, ndti]);
}

//texture add korbo
function addTexture(img) {
  var nirInt = img.select('nir').multiply(1000).toInt();
  var texture = nirInt.glcmTexture({
    size: 3,
  });

  return img.addBands([
    texture.select('nir_contrast').rename('NIR_Contrast'),
    texture.select('nir_ent').rename('NIR_entropy'),
    texture.select('nir_var').rename('NIR_variance'),
    texture.select('nir_diss').rename('NIR_dissimilarity'),
  ]);
}

// 4. Composite Generation
function getComposite(year) {
  var startAnnual = ee.Date.fromYMD(year, 1, 1);
  var endAnnual = ee.Date.fromYMD(year + 1, 1, 1);
  var startWinter = ee.Date.fromYMD(year, 12, 1).advance(-1, 'year');
  var endWinter = ee.Date.fromYMD(year, 3, 1);
  var annualCol, winterCol;

  if (year >= 2015) {
    var l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2');
    var l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2');
    var landsat89 = l8.merge(l9);

    annualCol = landsat89
      .filterBounds(aoi)
      .filterDate(startAnnual, endAnnual)
      .map(prepL8)
      .map(addIndicesAndTexture)
      .map(addTexture);
    winterCol = landsat89
      .filterBounds(aoi)
      .filterDate(startWinter, endWinter)
      .map(prepL8)
      .map(addIndicesAndTexture)
      .map(addTexture);
  } else {
    annualCol = ee
      .ImageCollection('LANDSAT/LT05/C02/T1_L2')
      .merge(ee.ImageCollection('LANDSAT/LE07/C02/T1_L2'))
      .filterBounds(aoi)
      .filterDate(startAnnual, endAnnual)
      .map(prepL5L7)
      .map(addIndicesAndTexture)
      .map(addTexture);
    winterCol = ee
      .ImageCollection('LANDSAT/LT05/C02/T1_L2')
      .merge(ee.ImageCollection('LANDSAT/LE07/C02/T1_L2'))
      .filterBounds(aoi)
      .filterDate(startWinter, endWinter)
      .map(prepL5L7)
      .map(addIndicesAndTexture)
      .map(addTexture);
  }

  var median = winterCol.median();
  var minNDVI = annualCol
    .select('NDVI')
    .reduce(ee.Reducer.percentile([10]))
    .rename('NDVI_min');
  var maxNDVI = annualCol
    .select('NDVI')
    .reduce(ee.Reducer.percentile([90]))
    .rename('NDVI_max');
  return median.addBands(maxNDVI).addBands(minNDVI).clip(aoi);
}

// 5. Topography
var dem = ee.Image('USGS/SRTMGL1_003').clip(aoi);
var elevation = dem.select('elevation').rename('ELEVATION');
var slope = ee.Terrain.slope(dem).rename('SLOPE');
var topoBands = elevation.addBands(slope);

// 7. Multi-temporal Composites
var img2000 = getComposite(2000).addBands(topoBands);
var img2010 = getComposite(2010).addBands(topoBands);
var img2020 = getComposite(2020).addBands(topoBands);
var img2025 = getComposite(2025).addBands(topoBands);

// 8.  Random Forest Classification
var esa = ee.ImageCollection('ESA/WorldCover/v100').first().clip(aoi);
var remappedESA = esa
  .remap([80, 90, 50, 40, 30, 10, 20, 95, 60], [0, 0, 1, 2, 2, 3, 3, 3, 4], 2)
  .rename('landcover');
var predictorBands = [
  'blue',
  'green',
  'red',
  'nir',
  'swir1',
  'swir2',
  'NDVI',
  'NDBI',
  'NDTI',
  'MNDWI',
  'BUI',
  'LSWI',
  'BSI',
  'SLOPE',
  'ELEVATION',
  'NDVI_max',
  'NIR_Contrast',
  'NIR_entropy',
  'NIR_variance',
  'NIR_dissimilarity',
];

var pureLandcover = remappedESA
  .focal_min({
    radius: 30,
    units: 'meters',
  })
  .rename('landcover');

var sampleImage = img2020.select(predictorBands).addBands(pureLandcover);
// Direct Stratified Sampling for small area

//validation
var sampleData = sampleImage
  .stratifiedSample({
    numPoints: 2500,
    classBand: 'landcover',
    region: aoi,
    scale: 30,
    seed: 42,
    geometries: true,
    tileScale: 4,
  })
  .randomColumn('random', 42);

var sampleDataWithCoords = sampleData.map(function (feat) {
  var coords = feat.geometry().coordinates();
  return feat.set({
    lon: coords.get(0),
    lat: coords.get(1),
  });
});

var lonMin = 89.48;
var lonMax = 89.62;
var latMin = 22.75;
var latMax = 22.9;

var lonStep = (lonMax - lonMin) / 4;
var latStep = (latMax - latMin) / 4;

var sampleWithCheckerboard = sampleDataWithCoords.map(function (feat) {
  var lon = ee.Number(feat.get('lon'));
  var lat = ee.Number(feat.get('lat'));

  var xBlock = lon.subtract(lonMin).divide(lonStep).floor().toInt();
  var yBlock = lat.subtract(latMin).divide(latStep).floor().toInt();

  // Checkerboard parity: (x + y) mod 2
  var checker = xBlock.add(yBlock).mod(2);
  return feat.set('checker_fold', checker);
});

// Fold 0 for Training (Spatially disjoint 50%), Fold 1 for Validation (Spatially disjoint 50%)
var trainingSet = sampleWithCheckerboard.filter(
  ee.Filter.eq('checker_fold', 0)
);
var validationSet = sampleWithCheckerboard.filter(
  ee.Filter.eq('checker_fold', 1)
);

/*var trainingSet=sampleData.filter(ee.Filter.lt('random',0.75));
var validationSet=sampleData.filter(ee.Filter.gte('random',0.75))*/

var classifier = ee.Classifier.smileRandomForest({
  numberOfTrees: 300,
  minLeafPopulation: 1,
  variablesPerSplit: 5,
  bagFraction: 0.7,
  seed: 42,
}).train({
  features: trainingSet,
  classProperty: 'landcover',
  inputProperties: predictorBands,
});

print('Training samples:', trainingSet.size());
print('Validation samples:', validationSet.size());

print(
  'Training class distribution:',
  trainingSet.aggregate_histogram('landcover')
);

print(
  'Validation class distribution:',
  validationSet.aggregate_histogram('landcover')
);

//post processing
var jrcWater = ee
  .Image('JRC/GSW1_4/GlobalSurfaceWater')
  .select('occurrence')
  .gt(80)
  .clip(aoi);

function cleanLULC(classifiedImg, compImg) {
  return classifiedImg
    .focal_mode({
      radius: 1.5,
      kernelType: 'square',
      units: 'pixels',
    })
    .rename('classification')
    .toUint8();
}

var lulc2000 = cleanLULC(
  img2000.select(predictorBands).classify(classifier),
  img2000
);
var lulc2010 = cleanLULC(
  img2010.select(predictorBands).classify(classifier),
  img2010
);
var lulc2020 = cleanLULC(
  img2020.select(predictorBands).classify(classifier),
  img2020
);
var lulc2025 = cleanLULC(
  img2025.select(predictorBands).classify(classifier),
  img2025
);

// 10. Visualization
var lulcPalette = ['0055ff', 'ff0000', 'ffd700', '008800', 'aaaaaa'];
Map.addLayer(
  img2025.select(['swir1', 'nir', 'red']),
  { min: 0.05, max: 0.45 },
  'FCC 2025'
);
Map.addLayer(
  lulc2025,
  { min: 0, max: 4, palette: lulcPalette },
  'Local LULC 2025'
);

// 11. Area Calculation (Direct Console Print)
function calculateArea(image, year) {
  var areaImage = ee.Image.pixelArea()
    .divide(1e6)
    .addBands(image.rename('class'));
  var stats = areaImage.reduceRegion({
    reducer: ee.Reducer.sum().group({
      groupField: 1,
      groupName: 'class_id',
    }),
    geometry: aoi,
    scale: 30,
    maxPixels: 1e9,
    tileScale: 4,
  });
  print('LULC area in sq_km (' + year + '):', stats.get('groups'));
}

calculateArea(lulc2020, 2020);

var transitionImage = lulc2000.multiply(10).add(lulc2025).rename('transition');
var transitionArea = ee.Image.pixelArea().divide(1e6).addBands(transitionImage);
var transitionStats = transitionArea.reduceRegion({
  reducer: ee.Reducer.sum().group({
    groupField: 1,
    groupName: 'transition_code',
  }),
  geometry: aoi,
  scale: 30,
  maxPixels: 1e13,
  tileScale: 4,
});
var classNames = {
  0: 'Water',
  1: 'Built-up',
  2: 'Agriculture',
  3: 'Forest',
  4: 'Barren',
};

var rawList = ee.List(transitionStats.get('groups'));
var formattedTransition = rawList.map(function (item) {
  var d = ee.Dictionary(item);
  var code = ee.Number(d.get('transition_code'));
  var area = ee.Number(d.get('sum'));
  var fromClass = code.divide(10).floor();
  var toClass = code.mod(10);
  return ee.Feature(null, {
    Transition_Code: code,
    From_Class_ID: fromClass,
    To_Class_ID: toClass,
    Area_sqkm: area,
  });
});

var transitionFC = ee.FeatureCollection(formattedTransition);
print('2000 to 2025 land cover transition', transitionFC);

Export.table.toDrive({
  collection: transitionFC,
  description: 'LULC_Transition_Matrix_2000_2025',
  folder: 'Khulna_LULC_Analysis',
  fileFormat: 'CSV',
});

var changeBinary = lulc2000.neq(lulc2025).rename('change_mask');

Map.addLayer(
  changeBinary.selfMask(),
  { palette: ['ff0000'] },
  'lulc change areas(2000-2025)'
);

//2020 accuracy assessment
var validated2020 = lulc2020.sampleRegions({
  collection: validationSet,
  properties: ['landcover'],
  scale: 30,
  geometries: true,
  tileScale: 4,
});

print(
  'Training/Validation sample distribution:',
  sampleData.aggregate_histogram('landcover')
);
var errorMatrix2020 = validated2020.errorMatrix('landcover', 'classification');
var overallAccuracy = errorMatrix2020.accuracy();
var kappaCoefficient = errorMatrix2020.kappa();
var producerAccuracy = errorMatrix2020.producersAccuracy();
var consumersAccuracy = errorMatrix2020.consumersAccuracy();
print('confusion matrix', errorMatrix2020);
print('overall accuracy', overallAccuracy);
print('kappa coefficient', kappaCoefficient);
print('Producer Accuracy', producerAccuracy);
print('consumers accuracy', consumersAccuracy);

var rfExplanation = classifier.explain();
print('Random Forest Explanation', rfExplanation);
print('Feature Importance:', ee.Dictionary(rfExplanation.get('importance')));
// 12. Export Tasks
function exportLULC(image, name) {
  Export.image.toDrive({
    image: image,
    description: name,
    scale: 30,
    region: aoi,
    fileFormat: 'GeoTIFF',
    crs: 'EPSG:4326',
    folder: 'Local_AOI_LULC',
    maxPixels: 1e9,
  });
}

exportLULC(lulc2000, 'Local_LULC_2000');
exportLULC(lulc2010, 'Local_LULC_2010');
exportLULC(lulc2020, 'Local_LULC_2020');
exportLULC(lulc2025, 'Local_LULC_2025');
