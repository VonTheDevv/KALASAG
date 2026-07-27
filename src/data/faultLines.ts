// ── Philippine Active Fault Lines Database ──────────────────────────
// Sources: PHIVOLCS published maps, Valley Fault System Atlas,
//          GEM Global Active Faults Database (CC BY-SA 4.0)
// Coordinates traced from official PHIVOLCS FaultFinder visualizations
// and peer-reviewed geological surveys.

export interface FaultLineSegment {
  id: string
  name: string
  system: string
  type: 'strike-slip' | 'thrust' | 'subduction'
  riskLevel: 'high' | 'moderate' | 'low'
  coordinates: [number, number][]   // [lat, lng] waypoints
  description: string
}

export const PH_FAULT_LINES: FaultLineSegment[] = [
  // ── VALLEY FAULT SYSTEM (Metro Manila) ──────────────────────────
  {
    id: 'wvf',
    name: 'West Valley Fault',
    system: 'Valley Fault System',
    type: 'strike-slip',
    riskLevel: 'high',
    coordinates: [
      [14.98, 121.08],   // Doña Remedios Trinidad, Bulacan
      [14.88, 121.06],   // Norzagaray
      [14.81, 121.04],   // San Jose del Monte
      [14.75, 121.06],   // Norzagaray-Rodriguez boundary
      [14.72, 121.10],   // Rodriguez / Montalban
      [14.69, 121.12],   // San Mateo
      [14.65, 121.10],   // Marikina City
      [14.61, 121.08],   // Marikina-Pasig boundary
      [14.57, 121.07],   // Pasig City
      [14.54, 121.06],   // Taguig north
      [14.50, 121.05],   // Taguig south
      [14.45, 121.04],   // Muntinlupa north
      [14.41, 121.04],   // Muntinlupa south
      [14.36, 121.05],   // San Pedro, Laguna
      [14.33, 121.07],   // Biñan
      [14.28, 121.08],   // Santa Rosa
      [14.25, 121.11],   // Cabuyao
      [14.19, 121.14],   // Calamba
    ],
    description: 'The West Valley Fault is the most dangerous segment of the Valley Fault System, capable of generating a M7.2+ earthquake. Last major movement ~1658. 4km permanent danger zone enforced by PHIVOLCS.'
  },
  {
    id: 'evf',
    name: 'East Valley Fault',
    system: 'Valley Fault System',
    type: 'strike-slip',
    riskLevel: 'high',
    coordinates: [
      [14.76, 121.14],   // Rodriguez north
      [14.72, 121.15],   // Rodriguez center
      [14.69, 121.16],   // San Mateo east
      [14.65, 121.17],   // Antipolo west
      [14.62, 121.18],   // Antipolo
      [14.56, 121.20],   // Teresa, Rizal
      [14.50, 121.22],   // Morong, Rizal
    ],
    description: 'The East Valley Fault runs parallel to the West Valley Fault through Rizal province. Together they form a system capable of affecting 12+ million residents in Metro Manila.'
  },

  // ── PHILIPPINE FAULT ZONE (PFZ) ────────────────────────────────
  {
    id: 'pfz-ilocos',
    name: 'Ilocos Segment',
    system: 'Philippine Fault Zone',
    type: 'strike-slip',
    riskLevel: 'moderate',
    coordinates: [
      [18.20, 120.60],   // Laoag area
      [17.90, 120.50],   // Batac
      [17.57, 120.39],   // Vigan
      [17.20, 120.45],   // Candon
      [16.90, 120.38],   // Tagudin
      [16.62, 120.32],   // San Fernando, La Union
    ],
    description: 'The Ilocos segment of the Philippine Fault Zone runs along the western Cordillera. Historical seismicity shows M6.0+ capability.'
  },
  {
    id: 'pfz-digdig',
    name: 'Digdig Segment',
    system: 'Philippine Fault Zone',
    type: 'strike-slip',
    riskLevel: 'high',
    coordinates: [
      [16.10, 121.20],   // Pantabangan, Nueva Ecija
      [15.85, 121.35],   // Bongabon
      [15.70, 121.10],   // Digdig, Nueva Ecija
      [15.55, 121.20],   // Gabaldon
      [15.35, 121.05],   // General Tinio
      [15.15, 121.00],   // Gapan
    ],
    description: 'The Digdig segment ruptured in the 1990 M7.7 Luzon earthquake, causing over 1,600 deaths. One of the most seismically active segments of the PFZ.'
  },
  {
    id: 'pfz-infanta',
    name: 'Infanta-Quezon Segment',
    system: 'Philippine Fault Zone',
    type: 'strike-slip',
    riskLevel: 'moderate',
    coordinates: [
      [14.74, 121.65],   // Infanta, Quezon
      [14.66, 121.60],   // Real, Quezon
      [14.40, 121.68],   // Polillo area
      [14.19, 121.73],   // Mauban
      [13.93, 121.62],   // Lucena
      [13.91, 122.10],   // Catanauan
      [13.91, 122.47],   // Guinayangan
    ],
    description: 'The Infanta-Quezon segment traverses the eastern coast of Luzon. Capable of M6.5+ earthquakes affecting Quezon province.'
  },
  {
    id: 'pfz-masbate',
    name: 'Masbate Segment',
    system: 'Philippine Fault Zone',
    type: 'strike-slip',
    riskLevel: 'moderate',
    coordinates: [
      [12.50, 123.45],   // Northern Masbate
      [12.37, 123.62],   // Masbate City
      [12.15, 123.55],   // Pio V. Corpuz
      [12.00, 123.55],   // Cataingan
      [11.80, 123.70],   // Southern Masbate
    ],
    description: 'The Masbate segment last produced a M6.6 earthquake in August 2020. Active monitoring by PHIVOLCS is ongoing.'
  },
  {
    id: 'pfz-leyte',
    name: 'Leyte Segment',
    system: 'Philippine Fault Zone',
    type: 'strike-slip',
    riskLevel: 'high',
    coordinates: [
      [11.44, 124.43],   // Calubian, northern Leyte
      [11.22, 124.40],   // Villaba
      [11.10, 124.50],   // Capocan
      [11.00, 124.61],   // Ormoc
      [10.88, 124.61],   // Kananga
      [10.74, 125.01],   // Abuyog
      [10.50, 125.05],   // Silago, Southern Leyte
      [10.38, 125.05],   // Saint Bernard
      [10.10, 125.10],   // Sogod, Southern Leyte
    ],
    description: 'The Leyte segment is one of the most hazardous segments of the PFZ. The 1994 M7.1 earthquake caused a tsunami in Leyte Gulf. Major population centers along the trace.'
  },
  {
    id: 'pfz-agusan',
    name: 'Agusan-Davao Segment',
    system: 'Philippine Fault Zone',
    type: 'strike-slip',
    riskLevel: 'high',
    coordinates: [
      [9.78, 125.50],    // Surigao City
      [9.30, 125.52],    // Mainit, Surigao del Norte
      [8.95, 125.54],    // Butuan City
      [8.71, 125.75],    // Bayugan, Agusan del Sur
      [8.30, 125.90],    // San Francisco
      [7.90, 126.00],    // Compostela
      [7.67, 126.08],    // New Bataan, Davao de Oro
      [7.30, 125.90],    // Nabunturan
      [7.07, 125.61],    // Davao City area
    ],
    description: 'The Agusan-Davao segment traverses the entire length of eastern Mindanao. The 2012 M6.9 Surigao earthquake struck near this trace. High risk due to dense population.'
  },

  // ── SUBDUCTION TRENCHES ────────────────────────────────────────
  {
    id: 'manila-trench',
    name: 'Manila Trench',
    system: 'Subduction Zone',
    type: 'subduction',
    riskLevel: 'moderate',
    coordinates: [
      [19.50, 119.50],
      [18.50, 119.00],
      [17.50, 119.00],
      [16.50, 119.10],
      [15.50, 119.30],
      [14.50, 119.50],
      [13.50, 119.80],
      [13.00, 119.90],
    ],
    description: 'The Manila Trench is a major subduction zone west of Luzon. Capable of generating M8.0+ megathrust earthquakes and tsunamis affecting Metro Manila and western Luzon coastlines.'
  },
  {
    id: 'ph-trench',
    name: 'Philippine Trench',
    system: 'Subduction Zone',
    type: 'subduction',
    riskLevel: 'moderate',
    coordinates: [
      [14.50, 126.50],
      [13.50, 126.40],
      [12.50, 126.60],
      [11.50, 126.70],
      [10.50, 126.80],
      [9.50, 126.90],
      [8.50, 127.00],
      [7.50, 127.10],
      [6.50, 127.20],
      [5.50, 127.00],
    ],
    description: 'The Philippine Trench is the deepest point in the Philippines (10,540m Emden Deep). This east-facing subduction zone is capable of M8.5+ megathrust earthquakes and Pacific-facing tsunamis.'
  },
  {
    id: 'cotabato-trench',
    name: 'Cotabato Trench',
    system: 'Subduction Zone',
    type: 'subduction',
    riskLevel: 'low',
    coordinates: [
      [7.50, 123.00],
      [7.00, 123.10],
      [6.50, 123.30],
      [6.00, 123.70],
      [5.80, 124.00],
      [5.30, 124.60],
    ],
    description: 'The Cotabato Trench lies south of Mindanao. Lower recurrence rate but capable of significant earthquakes affecting Cotabato and Zamboanga regions.'
  },
]
