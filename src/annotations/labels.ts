import type { LabelClass } from './types';

export const LABEL_CLASSES: LabelClass[] = [
  { id: 'car', name: 'Car', color: '#3b9dff', defaultHeight: 1.6 },
  { id: 'pedestrian', name: 'Pedestrian', color: '#ff5d73', defaultHeight: 1.8 },
  { id: 'cyclist', name: 'Cyclist', color: '#ffc43d', defaultHeight: 1.7 },
  { id: 'truck', name: 'Truck', color: '#a77dff', defaultHeight: 3.2 },
  { id: 'misc', name: 'Misc', color: '#3ddc97', defaultHeight: 1.0 },
];

export const labelById = (id: string) => LABEL_CLASSES.find((l) => l.id === id) ?? LABEL_CLASSES[0];
