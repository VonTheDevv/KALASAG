async function inspect() {
  try {
    const res = await fetch('https://www.gdacs.org/xml/gdacs.geojson');
    const data = await res.json();
    console.log("Total features:", data.features ? data.features.length : 0);
    
    if (!data.features) {
      console.log("Data sample:", JSON.stringify(data).slice(0, 500));
      return;
    }

    const tcFeatures = data.features.filter(f => f.properties && f.properties.eventtype === 'TC');
    console.log("Total TC features:", tcFeatures.length);
    
    tcFeatures.forEach((f, i) => {
      console.log(`\n--- TC Feature ${i} ---`);
      console.log("ID:", f.id);
      console.log("Properties:", JSON.stringify(f.properties, null, 2));
      console.log("Geometry Type:", f.geometry ? f.geometry.type : 'None');
      console.log("Coordinates:", f.geometry ? JSON.stringify(f.geometry.coordinates) : 'None');
    });
  } catch (err) {
    console.error("Inspect failed:", err);
  }
}

inspect();
