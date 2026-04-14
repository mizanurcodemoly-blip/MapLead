export interface Lead {
  id: string;
  name: string;
  address?: string;
  phone?: string;
  website?: string;
  email?: string;
  category: string;
  rating?: number;
  reviews?: number;
  lastUpdated: string;
}

export interface SearchParams {
  query: string;
  location: string;
  radius?: number;
}
